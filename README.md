# AutoHub Microservices Architecture

## Overview

This refactored architecture splits the monolithic application into independent microservices orchestrated by Nginx.

## Services

| Service             | Port | Responsibilities                                                     |
|---------------------|------|----------------------------------------------------------------------|
| `auth-service`      | 3001 | Authentication, Users, JWT                                           |
| `vehicle-service`   | 3002 | CarIntake, VIN decoding, Make/Model/Trim, JunkCar, VIN cron job      |
| `inventory-service` | 3003 | Inventory, Parts, Tags, Scrap Elements, Element Hub, Elements        |
| `transaction-service`| 3004 | Transactions, CheckIn, Invoice, EntryFee, PaymentSlip, Dashboard    |
| `people-service`    | 3005 | Sellers, Buyers, Customers, Waivers, Part Requests                   |
| `integration-service`| 3006 | Wix sync, Email/CRM, BackInStock notifications, Upload               |
| `nginx`             | 80   | API Gateway — routes, CORS, rate limiting, static files              |

## Getting Started

### Prerequisites
- Node.js >= 18
- MongoDB
- Nginx
- Docker (optional but recommended)

### Running All Services (Docker Compose)

```bash
cd microservices
docker-compose up --build
```

### Running Individually (without Docker)

```bash
# In each service directory
cd auth-service && npm install && npm start
cd vehicle-service && npm install && npm start
# ... etc
```

## Environment Variables

Each service has its own `.env` file. Copy `.env.example` in each service directory:

```bash
cp auth-service/.env.example auth-service/.env
# fill in values
```

**Shared variables (needed in most services):**
- `MONGODB_URI` — MongoDB connection string
- `JWT_SECRET` — JWT signing secret
- `NODE_ENV` — `development` or `production`

**Service-specific variables are documented in each service's `.env.example`.**

## Nginx Routing

| Path Prefix         | Routed To           |
|---------------------|---------------------|
| `/api/auth`         | auth-service:3001   |
| `/api/users`        | auth-service:3001   |
| `/api/car-intake`   | vehicle-service:3002|
| `/api/vin`          | vehicle-service:3002|
| `/api/make`         | vehicle-service:3002|
| `/api/model`        | vehicle-service:3002|
| `/api/trim`         | vehicle-service:3002|
| `/api/junk-car`     | vehicle-service:3002|
| `/api/inventory`    | inventory-service:3003|
| `/api/part`         | inventory-service:3003|
| `/api/scrap-element`| inventory-service:3003|
| `/api/element`      | inventory-service:3003|
| `/api/element-hub`  | inventory-service:3003|
| `/api/tags`         | inventory-service:3003|
| `/api/transactions` | transaction-service:3004|
| `/api/checkins`     | transaction-service:3004|
| `/api/invoices`     | transaction-service:3004|
| `/api/entry-fee`    | transaction-service:3004|
| `/api/dashboard`    | transaction-service:3004|
| `/api/sellers`      | people-service:3005 |
| `/api/buyers`       | people-service:3005 |
| `/api/customers`    | people-service:3005 |
| `/api/waivers`      | people-service:3005 |
| `/api/part-request` | people-service:3005 |
| `/api/wix`          | integration-service:3006|
| `/api/email`        | integration-service:3006|
| `/api/upload`       | integration-service:3006|
