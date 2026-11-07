# Graft backend

Takes raw email threads, decides which ones are sales-relevant, and turns the relevant ones into deals that a rep can read back. Express, TypeScript and PostgreSQL.

## How to run

You need Node 22+ and Docker.

```bash
npm install
cp .env.example .env
npm run db:up        
npm run db:migrate   
npm run db:seed      
npm run dev          
```



To start from an empty database (users are kept):

```bash
docker compose exec db psql -U graft -c "TRUNCATE threads, contacts RESTART IDENTITY CASCADE"
```

### Where things are

- `src/triage/provider.ts` is the two-model seam (`classify`, `extract`). `src/triage/stub-provider.ts` implements it using the rules in `src/triage/rules.ts`. The provider is swapped in one line in `src/app.ts`.
- `src/access/deal-accessor.ts` is the only reader of deals. It takes the acting user and applies the scope.
- `src/ingest/ingest-service.ts` handles duplicates, the two model calls, and the transaction that writes the deal.
- `src/routes/api.ts` contains the routes. They contain no SQL.

## Question 1. 

The line sits in `IngestService.ingest`, between `classify` and `extract`. Every thread goes through the cheap check, and only the threads that pass reach the expensive extraction call. The provider decides what passes, so the threshold can change without touching anything that calls it. A false positive costs one wasted extraction call and a junk deal the rep can see and delete. A false negative costs a real deal that never shows up, and nobody finds out. I would rather have false positives, because a mistake people can see gets fixed and an invisible one does not. The rules lean toward letting threads through for that reason: any rep-led conversation with an external reply counts as relevant. Every rejected thread is also stored with its reason, so rejections can be reviewed and re-checked later.

### 2. Where the privacy rule has to live

The rule has to live in the data access layer, in `DealAccessor`, which is built from the acting user and applies the scope in its own queries. That is where it lives now: a manager can open any deal, but message bodies come back as `null` unless the acting user owns the deal, and they are dropped in SQL, so they never leave the database for anyone else. It cannot live in the routes, and it cannot live in the assistant. The assistant should only get tools that go through that accessor as the user it is acting for, never the database or SQL, so it can only see what that user could see. I would add Postgres row-level security underneath as a backstop, so a bug in our own code still cannot read past it. Several things make me nervous about the current build:

- Bodies are hidden only on the deal read path. Any new reader of `messages` or `threads.raw` has to remember to do the same.
- The accessor is only a convention: anything holding the pool can query around it, and ingest already reads `threads` directly to check for duplicates.
- `X-User-Id` is trusted with no authentication, so anyone can claim to be a manager.
- Full raw mail is stored in `threads.raw`, one careless query away from leaking.
- `contacts` is shared across reps, with no owner and no scope.

### 3. What falls over under burst load

`POST /ingest` does all its work while the caller waits. With a real model behind it, every thread holds a request open through two model calls, so a burst of first syncs hits the model provider's rate limits first. Right after that, the pool of 10 database connections runs out, because each thread writes its messages one row at a time. We would see it as rising `/ingest` latency and timeouts, 429s coming back from the model, requests waiting for a database connection, and ingested threads per minute flattening while arrivals keep climbing. I would make ingest save the thread and return `202`, then hand triage to workers reading from a queue. A Postgres jobs table using `SKIP LOCKED` is enough at this size. The workers would cap concurrent model calls, retry with backoff, share capacity fairly so one rep's sync does not hold up everyone else, take the newest threads first, and write each thread's messages in one batch. I would leave the rest alone: the rules (they take microseconds), the provider interface, the accessor, the schema (a few hundred thousand rows is small for Postgres) and duplicate detection by message id, which already makes retries safe.

### 4. What was left out, and what two weeks would change

The full list is under **What I skipped** below. The biggest gaps are authentication, a real model, tests, and treating one company's threads as one deal. With two weeks I would add:

- Authentication, with row-level security as a backstop.
- A labelled set of threads to measure how many real deals the relevance check misses, then a real model tuned against it.
- The queue and workers from question 3.
- Companies as their own records, so one company's threads become one deal.
- An audit log of who read what, which matters once an assistant is reading the data.
- Tests, starting with the visibility rule, because it is the rule that matters most.


## What I skipped

- **Authentication.** `X-User-Id` is trusted as given.
- **A real model.** The stub provider wraps hand-written rules for both relevance and extraction. Swapping in a model means one new class that implements `TriageProvider`.
- **Tests.** Behaviour was checked by hand against the sample file.
- **Merging deals across threads.** It is one deal per thread, so two threads with the same company (Novatech) become two deals.
- **Scoping contacts.** Contacts are shared across reps and de-duplicated by email address only, so one person with two addresses becomes two contacts.
- **Flagging suspicious senders**, such as a company executive writing from a personal Gmail address.
- **Pagination** on `GET /deals`.
- **Retention rules for raw mail.** Relevant threads keep their raw JSON indefinitely. Rejected threads keep no mail, only a record and the reason.
- **Queueing, retries and rate limiting.** Ingest is synchronous; see question 3.
- **Logging and metrics** beyond errors.
