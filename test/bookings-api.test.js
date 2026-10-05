const assert = require('node:assert/strict');
const test = require('node:test');
const app = require('../src/server');
const pool = require('../src/db');

test('booking list and Payment Report endpoints return their expected contracts', async t => {
  const originalQuery = pool.query;
  const queries = [];
  const booking = {
    booking_reference: 'BOOKING-1',
    booked_amount: '175.00',
    total_paid_amount: '50.00',
    balance_due: '125.00',
    payment_history: []
  };
  const payment = {
    id: 42,
    booking_reference: 'BOOKING-1',
    amount: '50.00',
    payment_method: 'Card',
    payment_status: 'Succeeded'
  };

  pool.query = async (query, params) => {
    queries.push({ query, params });
    if (query.includes('SELECT * FROM payments WHERE is_deleted = FALSE')) {
      return { rows: [payment] };
    }
    return { rows: [booking] };
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pool.query = originalQuery;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const bookingsResponse = await fetch(`${baseUrl}/api/bookings`);
  assert.equal(bookingsResponse.status, 200);
  assert.deepEqual(await bookingsResponse.json(), { bookings: [booking] });
  assert.match(queries[0].query, /WITH payment_totals AS/);
  assert.match(queries[0].query, /distributed_paid_amount/);
  assert.match(queries[0].query, /AS balance_due/);
  assert.match(queries[0].query, /ORDER BY b\.check_in DESC NULLS LAST/);

  const reportResponse = await fetch(`${baseUrl}/api/report-data?type=payments`);
  assert.equal(reportResponse.status, 200);
  assert.deepEqual(await reportResponse.json(), { type: 'payments', rows: [payment] });
  assert.match(queries[1].query, /FROM payments WHERE is_deleted = FALSE/);
  assert.match(queries[1].query, /ORDER BY COALESCE\(payment_date, received_date_time\)/);
});
