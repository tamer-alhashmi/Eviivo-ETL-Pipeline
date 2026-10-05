# Eviivo Hotel Operations & ETL

A hotel reservation and operations web application backed by an Eviivo CSV import pipeline. It brings booking and payment data into PostgreSQL and provides a browser portal for reservation management, daily operations, payment reconciliation, expenses, settlements, and reporting.

## What it does

- Imports Eviivo booking and payment CSV exports into PostgreSQL, retaining source fields for reporting and reconciliation.
- Provides an operations portal with reservation search and editing, a booking calendar, booking and payment views, guest and property information, and daily operations tools.
- Tracks reservation payments, charges, cards, and internal messages; supports payment reconciliation and unpaid-reservation review.
- Records petty expenses and receipt images, and manages monthly cash settlements.
- Produces operational and financial reports, KPIs, charts, and reconciliation summaries.
- Can preview and synchronize configured daily task data to Google Sheets.
- Optionally generates AI-assisted reports with an OpenAI-compatible API and sends daily handovers to Zoho Cliq.

Google Sheets, AI reporting, Zoho Cliq, and receipt storage require the corresponding credentials and settings. n8n is not included or configured in this repository; it may be used separately as an external orchestration or integration layer.

## Architecture and data flow

```text
Eviivo CSV exports
        |
        +-- Manual import (`npm run import`)
        +-- Local folder watcher (`npm run watch`)
                    |
                    v
       Node.js CSV parsing and normalization
                    |
                    v
        PostgreSQL / Supabase tables and views
                    |
          +---------+-----------+
          |                     |
          v                     v
 Express API and portal    Google Sheets sync
 (local or Vercel)         (configured tasks)
          |
          +-- Optional OpenAI-compatible reports
          +-- Optional Zoho Cliq handover
          +-- Supabase Storage for receipt images
```

The browser application is served from `public/`. Express routes in `src/server.js` expose the application API; `api/index.js` is the Vercel function entry point. PostgreSQL access is handled by `pg` through `src/db.js`. SQL migrations live in `supabase/migrations/`, and `src/views.sql` defines reporting views. CSV parsing and import logic is in `src/importData.js`.

The import command currently scans the `Harbour`, `HH`, and `Orlando` subdirectories under `raw_data/`. CSV filenames containing `payment` (case-insensitive) are processed as payment exports; other CSV files in those folders are processed as bookings. The watcher uses the same filename rule for new or changed CSV files placed in a property/group subfolder.

## Technology

- Node.js 20 or later, CommonJS, Express 5, and a static HTML/JavaScript frontend.
- PostgreSQL, including Supabase-hosted PostgreSQL for deployment.
- Vercel for static frontend hosting and the Express API function.
- `csv-parser` and `chokidar` for CSV ingestion and local folder watching.
- Google Sheets API for configured operational data synchronization.
- Optional OpenAI-compatible report generation and Zoho Cliq webhooks.
- Supabase Storage for receipt images in the deployed application.

## Local development

### Prerequisites

- Node.js 20+ and npm.
- A PostgreSQL database accessible from the application.
- Eviivo CSV exports if you intend to run an import.

### Install and configure

```bash
npm ci
```

Create a local `.env` file (ignored by Git) with either a PostgreSQL connection URI or the local connection fields below. Use your own development database values; do not copy production secrets into source control.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URI. `POSTGRES_URL` and `POSTGRES_PRISMA_URL` are also accepted as alternatives. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Local PostgreSQL connection settings when no connection URI is set. |
| `PGSSLMODE` | Optional PostgreSQL SSL mode. Supabase connections should use SSL. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Optional service-account JSON for Google Sheets features. Locally, `GOOGLE_APPLICATION_CREDENTIALS` or a root `credentials.json` can be used instead. |
| `GOOGLE_SHEETS_IN_OUT_ID`, `GOOGLE_SHEETS_CASH_ID`, `GOOGLE_SHEETS_CARD_ID` | Spreadsheet IDs for their corresponding daily task syncs. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Required for deployed receipt uploads; keep the service-role key server-side only. |
| `SUPABASE_STORAGE_BUCKET` | Optional receipt bucket override; defaults to `receipts`. |
| `OPENAI_API_KEY`, `OPENAI_API_URL`, `OPENAI_MODEL` | Optional AI-report settings. |
| `ZOHO_CLIQ_WEBHOOK`, `ZOHO_CLIQ_WEBHOOK_<PROPERTY>` | Optional default or property-specific handover webhook. |

For the complete environment-variable list, Supabase connection guidance, and Vercel-specific requirements, see [DEPLOYMENT.md](DEPLOYMENT.md).

### Initialize and run

```bash
npm run migrate       # Apply tracked SQL migrations to the configured database
npm run server        # Start the application at http://localhost:3000
```

To import CSVs, put them in the appropriate `raw_data/<group>/` folder and run:

```bash
npm run import        # Import the recognized booking and payment CSVs
npm run watch         # Watch for newly added or changed CSVs
npm run dev           # Run the server and CSV watcher together
```

`npm run views` creates or updates the reporting views from `src/views.sql`. The migration and import commands write to the database configured in the environment; verify the target before running them.

## Scripts

| Command | Description |
| --- | --- |
| `npm test` | Run the Node.js test suite. |
| `npm run server` / `npm start` | Start the Express application. |
| `npm run dev` | Run the server and CSV watcher concurrently. |
| `npm run watch` | Watch `raw_data/` for new or updated CSV exports. |
| `npm run import` | Import booking and payment CSV files from the supported group folders. |
| `npm run migrate` / `npm run init` | Apply tracked SQL migrations to the configured PostgreSQL database. |
| `npm run migrate:data -- --dry-run` | Compare local PostgreSQL data with a Supabase destination without writing. |
| `npm run migrate:data -- --apply` | Copy local data to Supabase after reviewing the dry-run report. |
| `npm run views` | Create or refresh the reporting views. |

## Data transfer and migration status

The Supabase schema and data migration has already been completed in the source project. Vercel environment variables and the live deployment still require configuration in the Vercel dashboard; deployment is not complete merely because the repository contains the migration.

For a different Supabase target or a deliberate re-deployment, review [DEPLOYMENT.md](DEPLOYMENT.md) before applying migrations or transferring data. The tracked SQL migrations are additive and can migrate schema and supported legacy Prisma rows; the one-time local PostgreSQL transfer is a separate operation. The transfer script provides a dry run, preserves destination rows by default on identity conflicts, and does not delete source or destination rows. Do not run a destructive database reset against a hosted project.

## Deployment

1. Confirm the intended Supabase project and verify its schema/data state; the source project's migration is already complete.
2. Configure the required Production environment variables in the Vercel project settings. Add Preview or Development variables only if those environments should use Supabase.
3. Deploy the repository to Vercel. Vercel serves `public/` and routes API requests through `api/index.js`; no frontend build command is required.
4. Verify the live application and database connection, then configure optional Sheets, AI, Zoho, and receipt-storage integrations as needed.

Follow [DEPLOYMENT.md](DEPLOYMENT.md) for exact environment requirements, connection-string guidance, migration commands, and receipt storage configuration. Vercel dashboard setup and a live deployment remain operational steps.

## Security and data handling

- Never commit `.env` files, database credentials, service-account keys, webhook URLs, or other secrets.
- Do not commit raw Eviivo exports or other guest or payment data. Treat CSVs, database backups, and logs that may contain personal or financial information as sensitive.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, database credentials, and Google service-account private keys in server-side environment configuration; never expose them in browser code.
- Use least-privilege access for database, Google Sheets, and Supabase credentials, and protect deployment settings and database backups.
- The CSV importer writes booking and payment records to its configured database. Confirm both the selected environment and the import files before running a migration or import.
