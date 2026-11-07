import express from "express";
import helmet from "helmet";
import cors from "cors";
import { pool } from "./db/pool";
import { IngestService } from "./ingest/ingest-service";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { buildRoutes } from "./routes/api";
import { healthRouter } from "./routes/health";
import { StubProvider } from "./triage/stub-provider";

const triage = new StubProvider(); // <-- swap point: the only line that changes to use a real model provider
const ingest = new IngestService(pool, triage);

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/health", healthRouter);
app.use(buildRoutes(pool, ingest));

app.use(notFound);
app.use(errorHandler);
