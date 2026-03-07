import { SQLDatabase } from "encore.dev/storage/sqldb";

export const db = new SQLDatabase("backend", { migrations: "./migrations" });

export type Tx = Awaited<ReturnType<SQLDatabase["begin"]>>;
