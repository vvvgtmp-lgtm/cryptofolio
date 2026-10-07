import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings: no timezone surprises.
pg.types.setTypeParser(1082, (value: string) => value);

type Numeric = ColumnType<string, string | number, string | number>;
type NumericWithDefault = ColumnType<string, string | number | undefined, string | number>;
type Json<T> = ColumnType<T, string, string>;

export type JobType = 'export_csv' | 'import_csv' | 'report_pdf';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  avatar_key: string | null;
  created_at: Generated<Date>;
}
export interface PortfoliosTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  base_currency: Generated<string>;
  created_at: Generated<Date>;
}
export interface TransactionsTable {
  id: Generated<string>;
  portfolio_id: string;
  coin_id: string;
  type: 'buy' | 'sell';
  quantity: Numeric;
  price_usd: Numeric;
  fee_usd: NumericWithDefault;
  executed_at: ColumnType<Date, Date | string, Date | string>;
  note: string | null;
  created_at: Generated<Date>;
}
export interface WatchlistTable {
  user_id: string;
  coin_id: string;
  created_at: Generated<Date>;
}
export interface AlertsTable {
  id: Generated<string>;
  user_id: string;
  coin_id: string;
  direction: 'above' | 'below';
  target_price: Numeric;
  active: Generated<boolean>;
  triggered_at: Date | null;
  created_at: Generated<Date>;
}
export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Generated<Date>;
}
export interface PortfolioSnapshotsTable {
  portfolio_id: string;
  date: string;
  value_usd: Numeric;
}
export interface JobsTable {
  id: Generated<string>;
  user_id: string;
  type: JobType;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  params: Json<Record<string, unknown>>;
  result_key: string | null;
  result: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  error: string | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DB {
  users: UsersTable;
  portfolios: PortfoliosTable;
  transactions: TransactionsTable;
  watchlist: WatchlistTable;
  alerts: AlertsTable;
  notifications: NotificationsTable;
  portfolio_snapshots: PortfolioSnapshotsTable;
  jobs: JobsTable;
}

export function createDb(connectionString: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}
