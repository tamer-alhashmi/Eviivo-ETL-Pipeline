// ============================================================================
// [SECTION-01]: DEPENDENCIES, APP CONFIG & SCHEMA
// ============================================================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
let google;
try { google = require('googleapis').google; } catch (err) { google = null; }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservation_payments (
        payment_id SERIAL PRIMARY KEY,
        booking_reference VARCHAR(100) NOT NULL,
        order_reference VARCHAR(100),
        amount NUMERIC(10, 2) NOT NULL,
        payment_method VARCHAR(50) NOT NULL,
        card_brand VARCHAR(50),
        card_last_four VARCHAR(4),
        description TEXT,
        payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_payments_booking_ref ON reservation_payments(booking_reference);

      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_name VARCHAR(255);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS company_vat VARCHAR(100);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS property_name VARCHAR(255);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'GBP';
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(100);
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_date TIMESTAMP;
      CREATE UNIQUE INDEX IF NOT EXISTS payments_identity_idx ON payments(payment_id, booking_reference);
      UPDATE payments SET payment_date = received_date_time WHERE payment_date IS NULL;
      CREATE TABLE IF NOT EXISTS task_mapping_presets (
        preset_id SERIAL PRIMARY KEY,
        task_type VARCHAR(30) NOT NULL,
        preset_name VARCHAR(120) NOT NULL,
        mapping JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (task_type, preset_name)
      );
    `);
    console.log('✅ DB Schema Synchronized (Payments, Corporate & Notes).');
  } catch (err) {
    console.error('⚠️ DB Migration notice:', err.message);
  }
})();

// ============================================================================
// [CORE-LOGIC]: GROUP PAYMENTS DISTRIBUTION ENGINE
// ============================================================================
const DISTRIBUTED_CTE = `
  WITH group_aggregates AS (
    SELECT order_reference,
           SUM(COALESCE(total_revenue::numeric, 0)) AS group_total_booked,
           SUM(COALESCE(paid_amount::numeric, 0)) AS group_total_paid,
           COUNT(*) AS group_total_rooms
    FROM bookings
    WHERE order_reference IS NOT NULL AND TRIM(order_reference) != ''
    GROUP BY order_reference
  ),
  distributed_bookings AS (
    SELECT b.*,
           COALESCE(ga.group_total_rooms, 1) AS group_total_rooms,
           CASE 
             WHEN COALESCE(ga.group_total_rooms, 1) > 1 AND COALESCE(ga.group_total_booked, COALESCE(b.total_revenue::numeric, 0)) > 0 THEN 
               ROUND((COALESCE(b.total_revenue::numeric, 0) * (COALESCE(ga.group_total_paid, COALESCE(b.paid_amount::numeric, 0)) / ga.group_total_booked))::numeric, 2)
             ELSE COALESCE(b.paid_amount::numeric, 0)
           END AS distributed_paid_amount
    FROM bookings b
    LEFT JOIN group_aggregates ga ON b.order_reference = ga.order_reference
  )
`;

const sharedSelectSQL = `
  b.booking_reference, b.order_reference, b.property_name, b.company_name, b.company_vat,
  CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS guest_name, 
  b.telephone, b.email, b.room_unit_name, 
  TO_CHAR(b.check_in, 'YYYY-MM-DD') AS check_in, TO_CHAR(b.check_out, 'YYYY-MM-DD') AS check_out,
  b.nights, COALESCE(b.channel, 'Direct') AS channel, b.booking_status, b.total_revenue::numeric AS booked_amount,
  b.distributed_paid_amount::numeric AS total_paid_amount, 
  ROUND((b.total_revenue::numeric - b.distributed_paid_amount)::numeric, 2) AS balance_due,
  COALESCE(NULLIF(b.notes, ''), b.booking_notes, '') AS notes, 
  (SELECT COALESCE(json_agg(p ORDER BY p.payment_date DESC), '[]'::json) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference) AS payment_history,
  (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments p WHERE p.booking_reference = b.booking_reference AND amount < 0) AS total_charges
`;

// ============================================================================
// [SECTION-02]: HEALTH, PROPERTIES & DATE
// ============================================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/properties', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT property_name
      FROM (
        SELECT MIN(TRIM(property_name)) AS property_name
        FROM bookings
        WHERE property_name IS NOT NULL AND TRIM(property_name) <> ''
        GROUP BY LOWER(TRIM(property_name))
        UNION
        SELECT MIN(TRIM(property_name)) AS property_name
        FROM payments
        WHERE property_name IS NOT NULL AND TRIM(property_name) <> ''
        GROUP BY LOWER(TRIM(property_name))
      ) properties
      ORDER BY LOWER(property_name);
    `);
    res.json(result.rows.map(row => row.property_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/properties/rooms', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    if (!property || property === 'ALL') return res.json([]);
    const result = await pool.query(`SELECT MIN(TRIM(room_unit_name)) AS room_unit_name FROM bookings WHERE property_name IS NOT NULL AND LOWER(TRIM(property_name)) = LOWER(TRIM($1)) AND room_unit_name IS NOT NULL AND TRIM(room_unit_name) <> '' GROUP BY LOWER(TRIM(room_unit_name)) ORDER BY LOWER(TRIM(room_unit_name));`, [property]);
    res.json(result.rows.map(row => row.room_unit_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/schema/:tableName', async (req, res) => {
  try {
    const tableName = String(req.params.tableName || '').trim().toLowerCase();
    if (!['bookings', 'payments'].includes(tableName)) return res.status(400).json({ error: 'Only bookings and payments schemas are available.' });
    const result = await pool.query(`
      SELECT column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [tableName]);
    res.json({ table: tableName, columns: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/operations/latest-date', async (req, res) => {
  try {
    const result = await pool.query(`SELECT TO_CHAR(MAX(check_in), 'YYYY-MM-DD') as latest_date FROM bookings WHERE check_in IS NOT NULL;`);
    res.json({ latest_date: result.rows[0]?.latest_date || new Date().toISOString().split('T')[0] });
  } catch (err) { res.json({ latest_date: new Date().toISOString().split('T')[0] }); }
});

// ============================================================================
// [SECTION-03]: FULL EXECUTIVE ANALYTICS (RESTORED)
// ============================================================================
app.get('/api/kpis', async (req, res) => {
  try {
    const { property, from_date, to_date } = req.query;
    let whereClauses = []; const params = [];
    if (property && property !== 'ALL') { params.push(property.trim()); whereClauses.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (from_date && to_date) { params.push(from_date, to_date); whereClauses.push(`b.check_in::DATE >= $${params.length - 1}::DATE AND b.check_in::DATE <= $${params.length}::DATE`); }
    const filterCondition = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const kpiQuery = `${DISTRIBUTED_CTE} SELECT COUNT(DISTINCT b.booking_reference) AS total_bookings, COALESCE(SUM(b.total_revenue::numeric), 0)::numeric AS total_booked_revenue, COALESCE(SUM(b.distributed_paid_amount), 0)::numeric AS total_collected_revenue, COALESCE(SUM(CASE WHEN (b.total_revenue::numeric - b.distributed_paid_amount) > 0 THEN (b.total_revenue::numeric - b.distributed_paid_amount) ELSE 0 END), 0)::numeric AS total_outstanding_balance, COALESCE(SUM(CASE WHEN b.distributed_paid_amount <= 0 THEN 1 ELSE 0 END), 0) AS unpaid_count, COALESCE(SUM(CASE WHEN b.distributed_paid_amount >= b.total_revenue::numeric THEN 1 ELSE 0 END), 0) AS fully_paid_count FROM distributed_bookings b ${filterCondition};`;
    const result = await pool.query(kpiQuery, params); 
    res.json(result.rows[0] || {});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/reports/charts', async (req, res) => {
  try {
    const { property, from_date, to_date } = req.query;
    let whereClauses = []; const params = [];
    if (property && property !== 'ALL') { params.push(property.trim()); whereClauses.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (from_date && to_date) { params.push(from_date, to_date); whereClauses.push(`b.check_in::DATE >= $${params.length - 1}::DATE AND b.check_in::DATE <= $${params.length}::DATE`); }
    const whereSqlWithCheckin = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')} AND b.check_in IS NOT NULL` : 'WHERE b.check_in IS NOT NULL';
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const monthlyQuery = `${DISTRIBUTED_CTE} SELECT TO_CHAR(b.check_in, 'YYYY-MM') AS check_in_month, COALESCE(SUM(b.total_revenue::numeric), 0)::numeric AS revenue, COALESCE(SUM(b.distributed_paid_amount), 0)::numeric AS collected, COALESCE(SUM(CASE WHEN (b.total_revenue::numeric - b.distributed_paid_amount) > 0 THEN (b.total_revenue::numeric - b.distributed_paid_amount) ELSE 0 END), 0)::numeric AS unpaid FROM distributed_bookings b ${whereSqlWithCheckin} GROUP BY TO_CHAR(b.check_in, 'YYYY-MM') ORDER BY check_in_month ASC;`;
    const channelQuery = `${DISTRIBUTED_CTE} SELECT COALESCE(b.channel, 'Direct') AS channel, COALESCE(SUM(b.total_revenue::numeric), 0)::numeric AS revenue FROM distributed_bookings b ${whereSql} GROUP BY COALESCE(b.channel, 'Direct') ORDER BY revenue DESC;`;

    const [monthlyRes, channelRes] = await Promise.all([pool.query(monthlyQuery, params), pool.query(channelQuery, params)]);
    res.json({ monthly: monthlyRes.rows, channels: channelRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/reconciliation', async (req, res) => {
  try {
    const { property, status, search, from_date, to_date, limit = 25, offset = 0, name_sort = 'name_asc', hide_zero_paid = 'false', hide_blank_notes = 'false' } = req.query;
    let whereClauses = []; const params = [];
    if (property && property !== 'ALL') { params.push(property.trim()); whereClauses.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (from_date && to_date) { params.push(from_date, to_date); whereClauses.push(`b.check_in::DATE >= $${params.length - 1}::DATE AND b.check_in::DATE <= $${params.length}::DATE`); }
    if (status && status !== 'ALL') {
      if (status === 'Fully Paid') whereClauses.push(`b.distributed_paid_amount >= b.total_revenue::numeric`);
      else if (status === 'Partially Paid') whereClauses.push(`b.distributed_paid_amount > 0 AND b.distributed_paid_amount < b.total_revenue::numeric`);
      else if (status === 'Unpaid') whereClauses.push(`b.distributed_paid_amount <= 0`);
    }
    if (hide_zero_paid === 'true') whereClauses.push('b.distributed_paid_amount <> 0');
    if (hide_blank_notes === 'true') whereClauses.push("COALESCE(NULLIF(TRIM(b.notes), ''), NULLIF(TRIM(b.booking_notes), '')) IS NOT NULL");
    if (search && search.trim()) { params.push(`%${search.trim()}%`); whereClauses.push(`(b.booking_reference ILIKE $${params.length} OR CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $${params.length})`); }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const countResult = await pool.query(`${DISTRIBUTED_CTE} SELECT COUNT(*) FROM distributed_bookings b ${whereSql}`, params);
    const dataParams = [...params, parseInt(limit, 10), parseInt(offset, 10)];
    const nameOrder = name_sort === 'name_desc' ? 'DESC' : 'ASC';
    const dataQuery = `${DISTRIBUTED_CTE} SELECT ${sharedSelectSQL}, CASE WHEN b.distributed_paid_amount <= 0 THEN 'Unpaid' WHEN b.distributed_paid_amount >= b.total_revenue::numeric THEN 'Fully Paid' ELSE 'Partially Paid' END AS payment_status FROM distributed_bookings b ${whereSql} ORDER BY CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ${nameOrder} NULLS LAST, b.check_in DESC NULLS LAST LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length};`;
    const result = await pool.query(dataQuery, dataParams);
    res.json({ total: parseInt(countResult.rows[0].count, 10), data: result.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ============================================================================
// [SECTION-03B]: AI REPORTS (ALLOWLISTED, READ-ONLY REPORT BUILDER)
// ============================================================================
const AI_REPORTS = {
  daily_sales: { title: 'Daily Sales' },
  check_ins: { title: 'Check-ins' },
  in_out: { title: 'In and Out' },
  cash: { title: 'Cash Receipts' },
  card: { title: 'Card Receipts' },
  payments: { title: 'Payment Ledger' }
};

function reportFilters(query, dateColumn = 'b.check_in') {
  const clauses = [];
  const params = [];
  const property = String(query.property || '').trim();
  const fromDate = String(query.from_date || '').trim();
  const toDate = String(query.to_date || '').trim();
  if (property && property !== 'ALL') { params.push(property); clauses.push(`LOWER(TRIM(${/\bp\./.test(dateColumn) ? 'p.property_name' : 'b.property_name'})) = LOWER(TRIM($${params.length}))`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) { params.push(fromDate); clauses.push(`${dateColumn}::DATE >= $${params.length}::DATE`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) { params.push(toDate); clauses.push(`${dateColumn}::DATE <= $${params.length}::DATE`); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function buildAiReport(type, query) {
  const normalized = AI_REPORTS[type] ? type : 'daily_sales';
  if (normalized === 'cash' || normalized === 'card' || normalized === 'payments') {
    const method = normalized === 'cash' ? "LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'" : normalized === 'card' ? "(LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%card%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%visa%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%mastercard%')" : 'TRUE';
    const filters = reportFilters(query, 'COALESCE(p.payment_date, p.received_date_time)');
    const where = filters.sql ? `${filters.sql} AND ${method}` : `WHERE ${method}`;
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `SELECT p.payment_id AS "Payment ID", p.booking_reference AS "Booking Reference", COALESCE(p.property_name, b.property_name, 'Unknown') AS "Hotel", COALESCE(p.payment_date, p.received_date_time)::DATE AS "Payment Date", p.payment_method AS "Payment Method", p.payment_type AS "Payment Type", p.amount::NUMERIC AS "Amount", COALESCE(p.guest_name, CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)) AS "Guest" FROM payments p LEFT JOIN bookings b ON b.booking_reference = p.booking_reference ${where} ORDER BY COALESCE(p.payment_date, p.received_date_time) DESC NULLS LAST, p.payment_id`, params: filters.params };
  }
  if (normalized === 'daily_sales') {
    const filters = reportFilters(query, 'b.check_in');
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.check_in AS "Report Date", b.property_name AS "Hotel", COUNT(*)::INT AS "Bookings", COALESCE(SUM(b.total_revenue::NUMERIC), 0)::NUMERIC AS "Booked Revenue", COALESCE(SUM(b.distributed_paid_amount), 0)::NUMERIC AS "Collected Revenue", COALESCE(SUM(GREATEST(b.total_revenue::NUMERIC - b.distributed_paid_amount, 0)), 0)::NUMERIC AS "Outstanding" FROM distributed_bookings b ${filters.sql} GROUP BY b.check_in, b.property_name ORDER BY b.check_in DESC NULLS LAST, b.property_name`, params: filters.params };
  }
  const filters = reportFilters(query, normalized === 'in_out' ? 'b.check_in' : 'b.check_in');
  const dateClause = normalized === 'in_out' && filters.sql ? filters.sql.replace(/WHERE /, 'WHERE (b.check_in::DATE BETWEEN $1::DATE AND $2::DATE OR b.check_out::DATE BETWEEN $1::DATE AND $2::DATE) AND ') : filters.sql;
  if (normalized === 'in_out' && /^\d{4}-\d{2}-\d{2}$/.test(query.from_date) && /^\d{4}-\d{2}-\d{2}$/.test(query.to_date)) {
    const propertyParams = query.property && query.property !== 'ALL' ? [query.property] : [];
    const propertyClause = propertyParams.length ? ` AND LOWER(TRIM(b.property_name)) = LOWER(TRIM($${propertyParams.length + 2}))` : '';
    return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.booking_reference AS "Booking Reference", b.property_name AS "Hotel", CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS "Guest", b.check_in AS "Check-in Date", b.check_out AS "Check-out Date", b.room_unit_name AS "Room", b.booking_status AS "Status", b.total_revenue::NUMERIC AS "Booked Revenue" FROM distributed_bookings b WHERE (b.check_in::DATE BETWEEN $1::DATE AND $2::DATE OR b.check_out::DATE BETWEEN $1::DATE AND $2::DATE)${propertyClause} ORDER BY b.check_in DESC NULLS LAST`, params: [query.from_date, query.to_date, ...propertyParams] };
  }
  return { type: normalized, meta: AI_REPORTS[normalized], sql: `${DISTRIBUTED_CTE} SELECT b.booking_reference AS "Booking Reference", b.property_name AS "Hotel", CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) AS "Guest", b.check_in AS "Check-in Date", b.check_out AS "Check-out Date", b.room_unit_name AS "Room", b.booking_status AS "Status", b.total_revenue::NUMERIC AS "Booked Revenue", b.distributed_paid_amount::NUMERIC AS "Paid", ROUND((b.total_revenue::NUMERIC - b.distributed_paid_amount)::NUMERIC, 2) AS "Balance Due" FROM distributed_bookings b ${filters.sql} ORDER BY b.check_in DESC NULLS LAST`, params: filters.params };
}

function inferAiReport(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (text.includes('cash')) return 'cash';
  if (text.includes('card') || text.includes('visa') || text.includes('mastercard')) return 'card';
  if (text.includes('payment') || text.includes('receipt')) return 'payments';
  if (text.includes('check-in') || text.includes('check in') || text.includes('arrival')) return 'check_ins';
  if (text.includes('check-out') || text.includes('check out') || text.includes('departure') || text.includes('in and out')) return 'in_out';
  return 'daily_sales';
}

function createDatasetBrief(rows, context) {
  const numeric = key => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const keys = Object.keys(rows[0] || {});
  const amountKeys = keys.filter(key => /amount|revenue|paid|outstanding|balance|total/i.test(key) && rows.some(row => Number.isFinite(Number(row[key]))));
  const warnings = [];
  if (!rows.length) warnings.push('The selected dataset returned no rows for the requested scope.');
  if (rows.some(row => Object.values(row).some(value => value === null || value === ''))) warnings.push('The selected dataset contains missing values.');
  amountKeys.forEach(key => { if (numeric(key) < 0) warnings.push(`${key} contains a negative aggregate (${numeric(key).toFixed(2)}).`); });
  const scope = [context.property && context.property !== 'ALL' ? `hotel ${context.property}` : 'all hotels', context.from_date && context.to_date ? `${context.from_date} to ${context.to_date}` : 'the selected date scope'].join(' for ');
  const totals = amountKeys.slice(0, 3).map(key => `${key}: ${numeric(key).toFixed(2)}`).join('; ');
  return { headline: `${context.title} contains ${rows.length} record${rows.length === 1 ? '' : 's'} for ${scope}.`, summary: totals || `The dataset returned ${keys.length} fields: ${keys.join(', ')}.`, warnings, auditStatus: warnings.length ? 'Dataset review recommended' : 'No anomalies detected in this dataset', scope, fields: keys };
}

async function generateFinancialBrief(rows, context) {
  const datasetBrief = createDatasetBrief(rows, context);
  if (!process.env.OPENAI_API_KEY) return datasetBrief;
  try {
    const response = await fetch(process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.1, messages: [
        { role: 'system', content: 'You are a financial auditor. Analyze only the supplied report context and JSON rows. Do not invent figures, fields, dates, hotels, or explanations. Return JSON with headline, summary, warnings (array), and auditStatus.' },
        { role: 'user', content: JSON.stringify({ report: context, dataset: rows }) }
      ], response_format: { type: 'json_object' } })
    });
    if (!response.ok) throw new Error(`Brief model returned ${response.status}`);
    const result = await response.json();
    const parsed = JSON.parse(result.choices?.[0]?.message?.content || '{}');
    return { ...datasetBrief, ...parsed, warnings: Array.isArray(parsed.warnings) ? parsed.warnings : datasetBrief.warnings, scope: datasetBrief.scope, fields: datasetBrief.fields };
  } catch (err) {
    return { ...datasetBrief, modelNotice: 'LLM unavailable; brief generated from the returned dataset.' };
  }
}

app.post('/api/ai-reports/query', async (req, res) => {
  try {
    const type = String(req.body.prompt || '').trim() ? inferAiReport(req.body.prompt) : (req.body.type || 'daily_sales');
    const report = buildAiReport(type, req.body);
    const result = await pool.query(report.sql, report.params);
    const columns = result.rows.length ? Object.keys(result.rows[0]) : result.fields.map(field => field.name);
    const brief = await generateFinancialBrief(result.rows, { title: report.meta.title, reportType: report.type, prompt: req.body.prompt || '', property: req.body.property || 'ALL', from_date: req.body.from_date || '', to_date: req.body.to_date || '', sql: report.sql.replace(/\s+/g, ' ').trim() });
    res.json({ reportType: report.type, title: report.meta.title, columns, rows: result.rows, brief, generatedSql: report.sql.replace(/\s+/g, ' ').trim() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const DAILY_TASKS = {
  in_out: { title: 'In & Out', sheet: 'In and Out', idEnv: 'GOOGLE_SHEETS_IN_OUT_ID', key: 'booking_reference', sourceTable: 'bookings' },
  cash: { title: 'Cash', sheet: 'Cash', idEnv: 'GOOGLE_SHEETS_CASH_ID', key: 'payment_id', method: 'cash', sourceTable: 'payments' },
  card: { title: 'Card', sheet: 'Card', idEnv: 'GOOGLE_SHEETS_CARD_ID', key: 'payment_id', method: 'card', sourceTable: 'payments' }
};

function taskDefinition(type) { if (!DAILY_TASKS[type]) throw new Error('Unknown daily task.'); return DAILY_TASKS[type]; }
async function getLiveTableColumns(tableName) {
  const result = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tableName]);
  return result.rows.map(row => row.column_name);
}
function taskSourceQuery(type, body) {
  const task = taskDefinition(type); const params = []; const clauses = [];
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid task date is required.');
  params.push(date);
  if (body.property && body.property !== 'ALL') { params.push(String(body.property)); clauses.push(`LOWER(TRIM(${type === 'in_out' ? 'b.property_name' : 'p.property_name'})) = LOWER(TRIM($${params.length}))`); }
  if (type === 'in_out') {
    clauses.push(`(b.check_in::DATE = $1::DATE OR b.check_out::DATE = $1::DATE)`);
    return { sql: `${DISTRIBUTED_CTE} SELECT b.* FROM distributed_bookings b WHERE ${clauses.join(' AND ')} ORDER BY b.check_in, b.room_unit_name`, params };
  }
  const method = task.method === 'cash' ? "LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%cash%'" : "(LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%card%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%visa%' OR LOWER(TRIM(COALESCE(p.payment_method, ''))) LIKE '%mastercard%')";
  clauses.push(`COALESCE(p.payment_date, p.received_date_time)::DATE = $1::DATE`, method);
  return { sql: `SELECT p.* FROM payments p LEFT JOIN bookings b ON b.booking_reference = p.booking_reference WHERE ${clauses.join(' AND ')} ORDER BY p.payment_date DESC NULLS LAST, p.payment_id`, params };
}

function validateMapping(mapping, sourceColumns) {
  if (!Array.isArray(mapping) || !mapping.length) throw new Error('At least one mapped column is required.');
  const seen = new Set(); let keyCount = 0;
  mapping.forEach(item => {
    const header = String(item.header || '').trim(); const mode = item.mode === 'calculated' ? 'calculated' : 'column';
    if (!header || seen.has(header)) throw new Error('Mapped headers must be present and unique.');
    seen.add(header); if (item.isKey) keyCount += 1;
    if (mode === 'column' && !sourceColumns.includes(item.source)) throw new Error(`Unknown source column: ${item.source}`);
    if (mode === 'calculated') {
      const expression = String(item.expression || '').trim();
      const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      if (!expression || identifiers.some(identifier => !sourceColumns.includes(identifier)) || /[^A-Za-z0-9_ +().,'&-]/.test(expression)) throw new Error(`Invalid calculated expression for ${header}.`);
    }
  });
  if (keyCount !== 1) throw new Error('Select exactly one unique key column for upsert.');
  return mapping;
}

function evaluateMapping(item, row) {
  if (item.mode !== 'calculated') return row[item.source] ?? '';
  const expression = String(item.expression || '').trim();
  const parts = expression.split('+').map(part => part.trim()).filter(Boolean);
  const values = parts.map(part => row[part] ?? part.replace(/^['"]|['"]$/g, ''));
  if (parts.length > 1 && values.every(value => !Number.isNaN(Number(value)) && String(value).trim() !== '')) return values.reduce((sum, value) => sum + Number(value), 0);
  return values.join(' ').trim();
}

async function getTaskRows(type, body) { const source = taskSourceQuery(type, body); const result = await pool.query(source.sql, source.params); return { columns: result.fields.map(field => field.name), rows: result.rows }; }

app.get('/api/daily-tasks/meta', (req, res) => res.json({ tasks: DAILY_TASKS }));
app.get('/api/daily-tasks/presets', async (req, res) => { try { taskDefinition(req.query.task); const result = await pool.query('SELECT preset_id, task_type, preset_name, mapping, updated_at FROM task_mapping_presets WHERE task_type = $1 ORDER BY preset_name', [req.query.task]); res.json(result.rows); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/daily-tasks/presets', async (req, res) => { try { const task = taskDefinition(req.body.task); const mapping = validateMapping(req.body.mapping, await getLiveTableColumns(task.sourceTable)); const name = String(req.body.name || '').trim(); if (!name) throw new Error('Preset name is required.'); const result = await pool.query(`INSERT INTO task_mapping_presets (task_type, preset_name, mapping, updated_at) VALUES ($1, $2, $3::JSONB, NOW()) ON CONFLICT (task_type, preset_name) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = NOW() RETURNING preset_id, task_type, preset_name, mapping, updated_at`, [req.body.task, name, JSON.stringify(mapping)]); res.json(result.rows[0]); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/daily-tasks/preview', async (req, res) => { try { const task = taskDefinition(req.body.task); const data = await getTaskRows(req.body.task, req.body); const mapping = validateMapping(req.body.mapping, data.columns); res.json({ task, columns: data.columns, rows: data.rows.slice(0, 50), mappedRows: data.rows.slice(0, 50).map(row => mapping.map(item => evaluateMapping(item, row))) }); } catch (err) { res.status(400).json({ error: err.message }); } });

app.post('/api/daily-tasks/sync', async (req, res) => {
  try {
    if (!google || !process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Google Sheets credentials are not configured.');
    const task = taskDefinition(req.body.task); let mapping = req.body.mapping;
    if (req.body.preset_id) { const preset = await pool.query('SELECT mapping FROM task_mapping_presets WHERE preset_id = $1 AND task_type = $2', [req.body.preset_id, req.body.task]); if (!preset.rowCount) throw new Error('Selected preset was not found.'); mapping = preset.rows[0].mapping; }
    const data = await getTaskRows(req.body.task, req.body); mapping = validateMapping(mapping, data.columns); const keyItem = mapping.find(item => item.isKey); const keyIndex = mapping.indexOf(keyItem);
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }); const sheets = google.sheets({ version: 'v4', auth }); const spreadsheetId = process.env[task.idEnv]; if (!spreadsheetId) throw new Error(`${task.idEnv} is not configured.`);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${task.sheet}'!A:ZZ` }); const values = existing.data.values || []; const headers = mapping.map(item => item.header); const existingHeaders = values[0] || headers; const keyHeader = keyItem.header; const existingKeyIndex = Math.max(0, existingHeaders.indexOf(keyHeader)); const rowByKey = new Map(values.slice(1).map((row, index) => [String(row[existingKeyIndex] || ''), index + 2]));
    const updates = []; const appends = []; data.rows.forEach(row => { const mapped = mapping.map(item => String(evaluateMapping(item, row))); const key = mapped[keyIndex]; const sheetRow = existingHeaders.map(header => { const index = headers.indexOf(header); return index >= 0 ? mapped[index] : ''; }); if (key && rowByKey.has(key)) updates.push({ range: `'${task.sheet}'!A${rowByKey.get(key)}`, values: [sheetRow] }); else if (key) appends.push(sheetRow); });
    if (!values.length) await sheets.spreadsheets.values.update({ spreadsheetId, range: `'${task.sheet}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [headers] } });
    if (updates.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: updates } });
    if (appends.length) await sheets.spreadsheets.values.append({ spreadsheetId, range: `'${task.sheet}'!A:ZZ`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: appends } });
    res.json({ success: true, task: task.title, updated: updates.length, inserted: appends.length, skipped: data.rows.length - updates.length - appends.length, key: keyItem.header });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// ============================================================================
// [SECTION-04]: SMART GLOBAL SEARCH (HANDLES REVERSED NAMES)
// ============================================================================
app.get('/api/bookings/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);
    
    // Split search query by space to handle reversed names (e.g. "John Smith" vs "Smith John")
    const searchString = q.trim();
    const parts = searchString.split(/\s+/);
    
    let nameCondition = `CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $1`;
    let queryParams = [`%${searchString}%`];

    // If two words are entered, check both normal and reversed order
    if (parts.length === 2) {
      const reversedString = `${parts[1]} ${parts[0]}`;
      nameCondition = `(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $1 OR CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $2)`;
      queryParams.push(`%${reversedString}%`);
    }

    const result = await pool.query(`
      ${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL} FROM distributed_bookings b
      WHERE ${nameCondition}
         OR b.booking_reference ILIKE $1 
         OR b.order_reference ILIKE $1 
         OR b.telephone ILIKE $1 
         OR b.email ILIKE $1
      ORDER BY b.check_in DESC LIMIT 15;
    `, queryParams);
    
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-05]: UNPAID RESERVATIONS
// ============================================================================
app.get('/api/reservations/unpaid', async (req, res) => {
  try {
    const { property, from_date, to_date, search, limit = 50, offset = 0, name_sort = 'name_asc', hide_zero_paid = 'false', hide_blank_notes = 'false' } = req.query;
    let whereClauses = [`(b.total_revenue::numeric - b.distributed_paid_amount) > 0`, `LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')`];
    const params = [];

    if (property && property !== 'ALL') { params.push(property.trim()); whereClauses.push(`TRIM(b.property_name) ILIKE $${params.length}`); }
    if (from_date && to_date) { params.push(from_date, to_date); whereClauses.push(`b.check_in::DATE >= $${params.length - 1}::DATE AND b.check_in::DATE <= $${params.length}::DATE`); }
    if (search && search.trim()) { params.push(`%${search.trim()}%`); whereClauses.push(`(b.booking_reference ILIKE $${params.length} OR CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ILIKE $${params.length} OR b.order_reference ILIKE $${params.length})`); }
    if (hide_zero_paid === 'true') whereClauses.push('b.distributed_paid_amount <> 0');
    if (hide_blank_notes === 'true') whereClauses.push("COALESCE(NULLIF(TRIM(b.notes), ''), NULLIF(TRIM(b.booking_notes), '')) IS NOT NULL");
    
    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
    const summaryQuery = `${DISTRIBUTED_CTE} SELECT COUNT(*)::int AS total_unpaid_count, COALESCE(SUM(b.total_revenue::numeric), 0)::numeric AS total_booked_amount, COALESCE(SUM(b.total_revenue::numeric - b.distributed_paid_amount), 0)::numeric AS total_outstanding FROM distributed_bookings b ${whereSql};`;
    const summaryResult = await pool.query(summaryQuery, params);
    
    const dataParams = [...params, parseInt(limit, 10), parseInt(offset, 10)];
    const nameOrder = name_sort === 'name_desc' ? 'DESC' : 'ASC';
    const dataResult = await pool.query(`${DISTRIBUTED_CTE} SELECT ${sharedSelectSQL} FROM distributed_bookings b ${whereSql} ORDER BY CONCAT_WS(' ', b.guest_first_name, b.guest_last_name) ${nameOrder} NULLS LAST, b.check_in ASC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length};`, dataParams);
    
    res.json({ total: summaryResult.rows[0]?.total_unpaid_count || 0, summary: summaryResult.rows[0] || {}, data: dataResult.rows || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-06]: DAILY OPERATIONS
// ============================================================================
app.get('/api/operations/daily', async (req, res) => {
  try {
    const { property, date } = req.query;
    if (!date) return res.status(400).json({ error: 'Date is required.' });
    let propertyCondition = ''; const queryParams = [date];
    if (property && property !== 'ALL') { queryParams.push(property.trim()); propertyCondition = `AND TRIM(b.property_name) ILIKE TRIM($2)`; }

    const baseQuery = (dateCol) => `${DISTRIBUTED_CTE} SELECT ${sharedSelectSQL}, CASE WHEN b.distributed_paid_amount <= 0 THEN 'Payment on Arrival / Unpaid' WHEN b.distributed_paid_amount < b.total_revenue::numeric THEN 'Partially Paid' ELSE 'Fully Prepaid' END AS payment_status FROM distributed_bookings b WHERE b.${dateCol}::DATE = $1::DATE ${propertyCondition} AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled') ORDER BY b.room_unit_name ASC, b.check_in ASC;`;
    const [arrRes, depRes] = await Promise.all([pool.query(baseQuery('check_in'), queryParams), pool.query(baseQuery('check_out'), queryParams)]);
    res.json({ arrivals: arrRes.rows, departures: depRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/operations/duplicate-guests', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date is required.' });

    const query = `${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL},
        LOWER(REGEXP_REPLACE(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '\\s+', ' ', 'g')) AS guest_key
      FROM distributed_bookings b
      WHERE b.check_in::DATE = $1::DATE
        AND LOWER(TRIM(COALESCE(b.booking_status, ''))) NOT IN ('canceled', 'cancelled')
        AND NULLIF(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '') IS NOT NULL
        AND LOWER(REGEXP_REPLACE(TRIM(CONCAT_WS(' ', b.guest_first_name, b.guest_last_name)), '\\s+', ' ', 'g')) <> 'reserved ical'
      ORDER BY guest_key, b.property_name, b.check_in ASC;`;
    const result = await pool.query(query, [date]);
    const groups = new Map();

    result.rows.forEach(row => {
      const key = row.guest_key;
      if (!groups.has(key)) groups.set(key, { guest_name: row.guest_name, reservations: [], properties: new Set() });
      const group = groups.get(key);
      if (!group.reservations.some(item => item.booking_reference === row.booking_reference)) {
        group.reservations.push(row);
        group.properties.add((row.property_name || '').trim().toLowerCase());
      }
    });

    res.json([...groups.values()]
      .filter(group => group.properties.size > 1)
      .map(group => ({ guest_name: group.guest_name, property_count: group.properties.size, reservations: group.reservations })));
  } catch (err) {
    console.error('Duplicate guest lookup error:', err.message);
    res.status(500).json({ error: 'Unable to load duplicate guest suggestions.' });
  }
});

// ============================================================================
// [SECTION-07]: UPDATE BOOKING, ADD PAYMENTS & DELETE
// ============================================================================
app.post('/api/reservations/:ref/update', async (req, res) => {
  try {
    const { ref } = req.params;
    const { guest_name, telephone, email, company_name, company_vat, channel, booking_status, room_unit_name, property_name, notes } = req.body;
    
    const nameParts = (guest_name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const query = `
      UPDATE bookings SET 
        guest_first_name = $1, guest_last_name = $2, telephone = $3, email = $4,
        company_name = $5, company_vat = $6, channel = $7, booking_status = COALESCE(NULLIF($8, ''), booking_status), room_unit_name = $9, property_name = $10, notes = $11
      WHERE booking_reference = $12 RETURNING *;
    `;
    const updated = await pool.query(query, [firstName, lastName, telephone, email, company_name, company_vat, channel, booking_status, room_unit_name, property_name, notes, ref]);
    res.json({ success: true, booking: updated.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      booking_reference, property_name, room_unit_name, guest_name, check_in, check_out,
      total_revenue = 0, paid_amount = 0, channel = 'Direct', booking_status = 'Confirmed',
      telephone = '', email = '', notes = '', company_name = '', company_vat = '', adults = 1, children = 0
    } = req.body;
    const reference = String(booking_reference || '').trim();
    const property = String(property_name || '').trim();
    const room = String(room_unit_name || '').trim();
    const guest = String(guest_name || '').trim();
    const checkIn = String(check_in || '').trim();
    const checkOut = String(check_out || '').trim();
    const revenue = Number(total_revenue);
    const paid = Number(paid_amount);
    const adultCount = Number(adults);
    const childCount = Number(children);

    if (!property || !room || !guest || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      return res.status(400).json({ error: 'Property, room, guest, check-in, and check-out are required.' });
    }
    if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out must be after check-in.' });
    if (!Number.isFinite(revenue) || revenue < 0 || !Number.isFinite(paid) || paid < 0 || paid > revenue) return res.status(400).json({ error: 'Amounts must be valid, non-negative, and paid cannot exceed the total.' });
    if (!Number.isInteger(adultCount) || adultCount < 1 || !Number.isInteger(childCount) || childCount < 0) return res.status(400).json({ error: 'Guest counts are invalid.' });
    if (booking_status !== 'Confirmed' && booking_status !== 'Canceled') return res.status(400).json({ error: 'Booking status must be Confirmed or Canceled.' });

    const nameParts = guest.split(/\s+/);
    const firstName = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
    if (!Number.isInteger(nights) || nights < 1) return res.status(400).json({ error: 'Check-in and check-out must be valid calendar dates.' });
    const generatedReference = reference || `MAN-${Date.now().toString(36).toUpperCase()}`;

    await client.query('BEGIN');
    const duplicate = await client.query('SELECT 1 FROM bookings WHERE booking_reference = $1', [generatedReference]);
    if (duplicate.rowCount > 0) throw new Error('A booking with this reference already exists.');
    if (booking_status !== 'Canceled') {
      const overlap = await client.query(`
        SELECT booking_reference FROM bookings
        WHERE LOWER(TRIM(property_name)) = LOWER(TRIM($1))
          AND LOWER(TRIM(room_unit_name)) = LOWER(TRIM($2))
          AND LOWER(TRIM(COALESCE(booking_status, ''))) NOT IN ('canceled', 'cancelled')
          AND check_in < $4::DATE AND check_out > $3::DATE
        LIMIT 1;
      `, [property, room, checkIn, checkOut]);
      if (overlap.rowCount > 0) throw new Error(`Room is already booked for those dates (${overlap.rows[0].booking_reference}).`);
    }

    await client.query(`
      INSERT INTO bookings (
        booking_reference, property_name, guest_first_name, guest_last_name, telephone, email,
        room_unit_name, booking_status, channel, notes, company_name, company_vat,
        check_in, check_out, nights, adults, children, currency, total_revenue, paid_amount, booking_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::DATE, $14::DATE, $15, $16, $17, 'GBP', $18, $19, NOW())
    `, [generatedReference, property, firstName, lastName, telephone, email, room, booking_status, channel, notes, company_name, company_vat, checkIn, checkOut, nights, adultCount, childCount, revenue, paid]);

    if (paid > 0) {
      await client.query(`
        INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, description, payment_date)
        VALUES ($1, $1, $2, 'Manual Entry', 'Initial payment', NOW())
      `, [generatedReference, paid]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, booking_reference: generatedReference });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/api/reservations/:ref/status', async (req, res) => {
  try {
    const { ref } = req.params;
    const requestedStatus = String(req.body.booking_status || '').trim().toLowerCase();
    const bookingStatus = requestedStatus === 'canceled' || requestedStatus === 'cancelled' ? 'Canceled' : requestedStatus === 'confirmed' ? 'Confirmed' : null;
    if (!bookingStatus) return res.status(400).json({ error: 'Booking status must be Confirmed or Canceled.' });

    const result = await pool.query('UPDATE bookings SET booking_status = $1 WHERE booking_reference = $2 RETURNING booking_reference, booking_status;', [bookingStatus, ref]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reservation not found.' });
    res.json({ success: true, booking: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations/:ref/payments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    const { amount, payment_method, card_brand, card_last_four, description } = req.body;
    const parsedAmount = parseFloat(amount || 0);

    if (isNaN(parsedAmount) || parsedAmount === 0) return res.status(400).json({ error: 'Valid amount required.' });

    await client.query('BEGIN');
    const bookingRes = await client.query('SELECT order_reference FROM bookings WHERE booking_reference = $1 FOR UPDATE', [ref]);
    if (bookingRes.rowCount === 0) throw new Error('Reservation not found.');

    const pRes = await client.query(`
      INSERT INTO reservation_payments (booking_reference, order_reference, amount, payment_method, card_brand, card_last_four, description, payment_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *;
    `, [ref, bookingRes.rows[0].order_reference || ref, parsedAmount, payment_method, card_brand || null, card_last_four || null, description]);

    await client.query(`UPDATE bookings b SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments WHERE booking_reference = b.booking_reference) WHERE booking_reference = $1;`, [ref]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, payment: pRes.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.delete('/api/payments/:payment_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { payment_id } = req.params;
    await client.query('BEGIN');

    const paymentRes = await client.query('DELETE FROM reservation_payments WHERE payment_id = $1 RETURNING booking_reference', [payment_id]);
    if (paymentRes.rowCount === 0) throw new Error('Record not found.');

    const ref = paymentRes.rows[0].booking_reference;
    await client.query(`UPDATE bookings b SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM reservation_payments WHERE booking_reference = b.booking_reference) WHERE booking_reference = $1;`, [ref]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

app.delete('/api/reservations/:ref', async (req, res) => {
  const client = await pool.connect();
  try {
    const { ref } = req.params;
    await client.query('BEGIN');
    await client.query('DELETE FROM reservation_payments WHERE booking_reference = $1', [ref]);
    const result = await client.query('DELETE FROM bookings WHERE booking_reference = $1 RETURNING *', [ref]);
    if (result.rowCount === 0) throw new Error('Reservation not found.');
    await client.query('COMMIT');
    res.json({ success: true, message: `Reservation ${ref} deleted.` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); } finally { client.release(); }
});

// ============================================================================
// [SECTION-08]: CALENDAR FEED
// ============================================================================
app.get('/api/calendar/feed', async (req, res) => {
  try {
    const property = String(req.query.property || '').trim();
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    if (!property || property === 'ALL' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: 'Property, start_date, and end_date are required.' });
    }

    const roomQuery = `
      SELECT MIN(TRIM(room_unit_name)) AS room_unit_name
      FROM bookings
      WHERE LOWER(TRIM(property_name)) = LOWER(TRIM($1))
        AND room_unit_name IS NOT NULL
        AND TRIM(room_unit_name) <> ''
      GROUP BY LOWER(TRIM(room_unit_name))
      ORDER BY LOWER(TRIM(room_unit_name));
    `;
    const bookingQuery = `
      ${DISTRIBUTED_CTE}
      SELECT ${sharedSelectSQL}
      FROM distributed_bookings b
      WHERE LOWER(TRIM(b.property_name)) = LOWER(TRIM($1))
        AND b.check_in IS NOT NULL
        AND b.check_out IS NOT NULL
        AND b.check_in::DATE <= $3::DATE
        AND b.check_out::DATE > $2::DATE
      ORDER BY b.room_unit_name ASC, b.check_in ASC, b.check_out ASC;
    `;
    const [roomsResult, bookingsResult] = await Promise.all([
      pool.query(roomQuery, [property]),
      pool.query(bookingQuery, [property, startDate, endDate])
    ]);

    res.json({
      rooms: roomsResult.rows.map(row => row.room_unit_name),
      bookings: bookingsResult.rows
    });
  } catch (err) {
    console.error('Calendar feed error:', err.message);
    res.status(500).json({ error: 'Unable to load calendar data.' });
  }
});

// ============================================================================
// [SECTION-09]: ZOHO CLIQ WEBHOOK DISPATCHER
// ============================================================================
app.post('/api/operations/send-cliq', async (req, res) => {
  try {
    const { property, date, arrivals = [], departures = [] } = req.body;
    if (!date) return res.status(400).json({ error: 'Date is required.' });

    const hotelTitle = property && property !== 'ALL' ? property : 'All Portfolio Properties';
    const sanitizedKey = property ? property.toUpperCase().replace(/[^A-Z0-9]/g, '_') : '';
    const webhookUrl = process.env[`ZOHO_CLIQ_WEBHOOK_${sanitizedKey}`] || process.env.ZOHO_CLIQ_WEBHOOK;

    if (!webhookUrl) return res.status(404).json({ error: `No Webhook found.` });

    const totalDue = arrivals.reduce((acc, r) => acc + Math.max(0, parseFloat(r.balance_due || 0)), 0);
    const unpaidCount = arrivals.filter(r => parseFloat(r.balance_due || 0) > 0).length;

    let text = `🏨 *Daily Operational Handover — ${hotelTitle}*\n📅 *Target Date:* ${date}\n━━━━━━━━━━━━━━━━━━━━\n📊 *Summary:* 📥 Arrivals: *${arrivals.length}* | 📤 Departures: *${departures.length}*\n💰 *Pending Collect on Arrival:* *£${totalDue.toFixed(2)}* (${unpaidCount} bookings)\n\n`;

    text += `📥 *EXPECTED ARRIVALS:*\n`;
    if (arrivals.length === 0) text += `_No expected arrivals._\n\n`;
    else {
      arrivals.forEach((a, idx) => {
        const bal = parseFloat(a.balance_due || 0);
        const payTag = bal > 0 ? `⚠️ *Collect £${bal.toFixed(2)}*` : `✅ *Settled*`;
        text += `${idx + 1}. *${a.room_unit_name || 'Room N/A'}* — *${a.guest_name}* (${a.channel || 'Direct'})\n   └ Status: ${payTag}${a.telephone ? ' | 📞 '+a.telephone : ''}\n`;
      }); text += `\n`;
    }

    text += `📤 *EXPECTED DEPARTURES:*\n`;
    if (departures.length === 0) text += `_No expected departures._\n`;
    else {
      departures.forEach((d, idx) => {
        const bal = parseFloat(d.balance_due || 0);
        const depStatus = bal > 0 ? `⚠️ *Pending Balance £${bal.toFixed(2)}*` : `✅ *Cleared*`;
        text += `${idx + 1}. *${d.room_unit_name || 'Room N/A'}* — *${d.guest_name}* | ${depStatus}\n`;
      });
    }

    const cliqRes = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, card: { title: `Daily Handover: ${hotelTitle}`, theme: 'modern-inline' } }) });
    if (!cliqRes.ok) throw new Error(await cliqRes.text());
    res.json({ success: true, message: `Handover briefing sent to Zoho Cliq for ${hotelTitle}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// [SECTION-09]: SERVER BOOTSTRAPPER
// ============================================================================
app.listen(PORT, () => console.log(`🚀 Hospitality Management Portal active at: http://localhost:${PORT}`));
