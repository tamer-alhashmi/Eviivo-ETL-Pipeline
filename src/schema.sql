DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;

CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    booking_reference VARCHAR(100) UNIQUE NOT NULL,
    order_reference VARCHAR(100),
    ota_reference VARCHAR(100),
    property_name VARCHAR(255),
    guest_first_name VARCHAR(100),
    guest_last_name VARCHAR(100),
    telephone VARCHAR(50),
    email VARCHAR(255),
    room_unit_name VARCHAR(255),
    room_unit_type VARCHAR(255),
    booking_status VARCHAR(100),
    channel VARCHAR(100),
    currency VARCHAR(10) DEFAULT 'GBP',
    notes TEXT,
    booking_notes TEXT,
    company_name VARCHAR(255),
    company_vat VARCHAR(100),
    booking_date TIMESTAMP,
    check_in DATE,
    check_out DATE,
    nights INT,
    adults INT DEFAULT 0,
    children INT DEFAULT 0,
    other_revenue NUMERIC(12, 2),
    total_revenue NUMERIC(12, 2),
    paid_amount NUMERIC(12, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    raw_data JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- جدول المدفوعات (Payments)
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    payment_id VARCHAR(100) NOT NULL,
    booking_reference VARCHAR(100),
    order_reference VARCHAR(100),
    received_date_time TIMESTAMP,
    guest_name VARCHAR(255),
    business_name VARCHAR(255),
    room_name VARCHAR(255),
    channel VARCHAR(100),
    channel_reference VARCHAR(100),
    payment_type VARCHAR(100),
    payment_method VARCHAR(100),
    property_name VARCHAR(255),
    currency VARCHAR(10) DEFAULT 'GBP',
    payment_status VARCHAR(100),
    payment_date TIMESTAMP,
    amount NUMERIC(10, 2),
    raw_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payments_identity UNIQUE (payment_id, booking_reference)
);