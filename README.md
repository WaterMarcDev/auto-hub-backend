# AutoHub Backend

Node.js + Express REST API backend for the AutoHub platform. This service provides authentication, car intake management, inventory tracking, waiver processing, buyer/seller management, transaction handling, reporting, and integrations (VIN decoding, Wix integration).

## Tech Stack

- **Runtime**: Node.js (LTS recommended)
- **Framework**: Express.js 5.1.0
- **Database**: MongoDB with Mongoose 8.16.0
- **Authentication**: JWT (jsonwebtoken 9.0.2) with httpOnly cookies
- **Validation**: express-validator 7.2.1
- **File Uploads**: Multer 2.0.1
- **Templating**: Nunjucks 3.2.4 (for invoices, payment slips)
- **Email**: Nodemailer 7.0.5 (with MJML 4.15.3 for email templates)
- **Security**: Helmet 8.1.0, CORS 2.8.5
- **Logging**: Morgan 1.10.0, custom logger
- **Background Jobs**: node-cron 4.2.1
- **Utilities**: 
  - bcryptjs 3.0.2 (password hashing)
  - cookie-parser 1.4.7
  - marked 16.4.0 (Markdown parsing)
  - xlsx 0.18.5 (Excel file handling)

## Project Structure

```
auto-hub-backend/
├── server.js                    # Application entry point, Express app setup
├── package.json                 # Dependencies and scripts
│
├── config/                      # Configuration files
│   ├── database.js              # MongoDB connection setup
│   └── logger.js                # Logger configuration
│
├── controllers/                 # Request handlers (business logic)
│   ├── auth.controller.js       # Authentication (login, register, refresh)
│   ├── carIntake.controller.js  # Car intake operations
│   ├── dashboard.controller.js  # Dashboard metrics and aggregates
│   ├── buyer.controller.js     # Buyer management
│   ├── seller.controller.js    # Seller management
│   ├── inventory.controller.js # Inventory management
│   ├── invoice.controller.js   # Invoice generation
│   ├── waiver.controller.js    # Waiver processing
│   ├── transaction.controller.js # Transaction handling
│   ├── vin.controller.js       # VIN decoding operations
│   ├── wix.controller.js       # Wix integration
│   └── ...                     # Other domain controllers
│
├── routes/                      # Express route definitions
│   ├── auth.routes.js           # Authentication routes
│   ├── users.routes.js          # User management routes
│   ├── carIntake.routes.js      # Car intake routes
│   ├── inventory.routes.js     # Inventory routes
│   ├── buyer.routes.js         # Buyer routes
│   ├── sellers.routes.js       # Seller routes
│   ├── waiver.routes.js        # Waiver routes
│   ├── transactions.routes.js  # Transaction routes
│   ├── invoice.routes.js       # Invoice routes
│   ├── dashboard.routes.js     # Dashboard routes
│   ├── vin.routes.js           # VIN routes
│   ├── wix.routes.js           # Wix integration routes
│   └── ...                     # Other route modules
│
├── models/                      # Mongoose schemas/models
│   ├── User.model.js           # User model
│   ├── CarIntake.model.js      # Car intake model
│   ├── Inventory.model.js      # Inventory model
│   ├── Buyer.model.js          # Buyer model
│   ├── Seller.model.js         # Seller model
│   ├── Waiver.model.js         # Waiver model
│   ├── Transaction.model.js    # Transaction model
│   ├── Invoice.model.js        # Invoice model
│   ├── Part.model.js           # Part model
│   ├── Element.model.js        # Elements model
│   ├── ElementHub.model.js     # Element hub model
│   └── ...                     # Other models
│
├── middleware/                  # Express middleware
│   ├── auth.js                 # JWT authentication middleware
│   ├── validation.js           # Request validation middleware
│   ├── logging.js              # Request logging middleware
│   └── wixAuth.js              # Wix authentication middleware
│
├── services/                    # Business logic services
│   └── tag.service.js          # Tag-related business logic
│
├── jobs/                        # Background/scheduled jobs
│   └── fetchVinDetailsJob.js   # Scheduled VIN detail fetching
│
├── scripts/                     # Operational scripts
│   ├── seedAdmin.js            # Seed initial admin user
│   └── verifyElementHub.js     # Element hub verification script
│
├── views/                       # Nunjucks templates
│   ├── invoice.njk             # Invoice template
│   └── paymentSlip.njk         # Payment slip template
│
├── utils/                       # Utility functions
│   └── logger.js               # Logger utility wrapper
│
├── assets/                      # Static assets
│   └── logo-sm1.png           # Logo image
│
└── API_DOCS.md                  # Complete API endpoint documentation
```

## Getting Started

### Prerequisites

- **Node.js**: LTS version (18.x or higher recommended)
- **npm**: Bundled with Node.js
- **MongoDB**: MongoDB instance (local or cloud like MongoDB Atlas)
  - MongoDB 4.4+ recommended
- **Environment Variables**: `.env` file with required configuration

### Installation

1. Navigate to the backend directory:
   ```bash
   cd auto-hub-backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

This installs all runtime and development dependencies defined in `package.json`.

### Environment Configuration

Create a `.env` file in the `auto-hub-backend` root directory with the following variables:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/autohub
# Or for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/autohub

# JWT Authentication
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=7d

# CORS Configuration
CLIENT_URL=http://localhost:5173

# Email Configuration (if using email features)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password

# File Upload Configuration
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=10485760

# External API Keys (if applicable)
VIN_API_KEY=your-vin-api-key
WIX_API_KEY=your-wix-api-key
WIX_SITE_ID=your-wix-site-id
```

**Security Note**: Never commit `.env` files to version control. Add `.env` to `.gitignore`.

### Database Setup

1. Ensure MongoDB is running locally or configure connection string for cloud MongoDB.

2. The application will automatically connect to MongoDB on startup via `config/database.js`.

3. (Optional) Seed the automation bot account:
   ```bash
   npm run seed:automation-bot
   ```

## Running the Server

### Development Mode

Start the server with auto-reload (using nodemon):

```bash
npm run dev
```

The server will:
- Connect to MongoDB
- Start on the port specified in `PORT` (default: 5000)
- Auto-reload on file changes
- Display connection status and startup logs

### Production Mode

Start the server in production:

```bash
npm start
```

**Production Recommendations**:
- Use a process manager like PM2, systemd, or Docker
- Set `NODE_ENV=production`
- Use environment-specific `.env` files
- Enable proper logging and monitoring
- Set up health checks
- Configure reverse proxy (nginx) if needed

### Example with PM2

```bash
pm2 start server.js --name autohub-backend
pm2 save
pm2 startup
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the server (production mode) |
| `npm run dev` | Start server with nodemon (development mode) |
| `npm run seed:automation-bot` | Seed the automation bot account |

## API Overview

The API is organized by domain areas. All routes are prefixed with `/api` (except static uploads served at `/uploads`).

### Main API Endpoints

- **Authentication**: `/api/auth` - Login, register, token refresh
- **Users**: `/api/users` - User management (Admin only)
- **Car Intake**: `/api/car-intake` - Car intake operations
- **Inventory**: `/api/inventory` - Inventory management
- **Parts**: `/api/parts` - Part management
- **Elements**: `/api/elements` - Element management
- **Buyers**: `/api/buyers` - Buyer management
- **Sellers**: `/api/sellers` - Seller management
- **Waivers**: `/api/waivers` - Waiver processing
- **Transactions**: `/api/transactions` - Transaction handling
- **Invoices**: `/api/invoices` - Invoice generation
- **Dashboard**: `/api/dashboard` - Dashboard metrics
- **VIN**: `/api/vin` - VIN decoding
- **Wix**: `/api/wix` - Wix integration
- **Uploads**: `/uploads` - Static file serving

### Complete API Documentation

For detailed endpoint documentation, request/response formats, authentication requirements, and examples, see **`API_DOCS.md`**.

## Authentication & Authorization

### JWT Authentication

The backend uses JWT (JSON Web Tokens) for authentication:

1. **Login**: User authenticates via `/api/auth/login`
2. **Token Generation**: Server generates JWT token
3. **Token Storage**: Token stored in httpOnly cookie (name: `token`) or returned in response
4. **Token Validation**: `middleware/auth.js` validates token on protected routes
5. **Token Refresh**: `/api/auth/refresh` endpoint for token renewal

### Protected Routes

Routes requiring authentication use the `auth` middleware:

```javascript
const { protect } = require('./middleware/auth');

router.get('/protected-route', protect, controller.handler);
```

### Role-Based Access Control

The application supports role-based access:
- **Admin**: Full system access
- **Manager**: Management-level access
- **Staff**: Operational access
- **Front Desk**: Limited access

Role checks are typically implemented in controllers or additional middleware.

## Request Validation

The backend uses `express-validator` for request validation:

- **Middleware**: `middleware/validation.js` handles validation errors
- **Validation Rules**: Defined per route using express-validator chains
- **Error Responses**: Standardized error format: `{ error: "message" }`

Example:
```javascript
const { body, validationResult } = require('express-validator');

router.post('/endpoint',
  [
    body('email').isEmail(),
    body('password').isLength({ min: 6 })
  ],
  controller.handler
);
```

## File Uploads

File uploads are handled using Multer:

- **Configuration**: Multer configured in upload routes
- **Storage**: Files stored in `UPLOAD_DIR` (default: `./uploads`)
- **Max Size**: Configurable via `MAX_FILE_SIZE` environment variable
- **Static Serving**: Uploaded files served at `/uploads` route

Ensure upload directory exists and has proper permissions.

## Background Jobs

Scheduled jobs are configured using `node-cron`:

- **VIN Details Job**: `jobs/fetchVinDetailsJob.js` - Fetches VIN details on schedule
- **Job Registration**: Jobs are registered in `server.js` on startup

To add a new scheduled job:

1. Create job file in `jobs/`
2. Configure cron schedule
3. Import and start in `server.js`

## Views & Templates

Nunjucks templates are used for document generation:

- **Invoice Template**: `views/invoice.njk` - Rendered for invoice PDFs/emails
- **Payment Slip Template**: `views/paymentSlip.njk` - Rendered for payment slips

Templates use Nunjucks filters:
- `usDate` - Format dates in US format
- `usCurrency` - Format numbers as US currency

## Logging

The application uses multiple logging mechanisms:

- **Morgan**: HTTP request logging middleware
- **Custom Logger**: `config/logger.js` and `utils/logger.js` for application logs
- **User Context**: `middleware/logging.js` adds user context to logs

Logs include:
- Request method, URL, status, response time
- User information (when authenticated)
- Error details

## Security Best Practices

1. **Environment Variables**: Never commit secrets; use `.env` files
2. **JWT Secret**: Use strong, random secret; rotate periodically
3. **Helmet**: Security headers configured via Helmet middleware
4. **CORS**: Configured to allow only trusted frontend origins
5. **Input Validation**: All user input validated and sanitized
6. **Password Hashing**: bcryptjs used for password hashing
7. **HttpOnly Cookies**: JWT tokens in httpOnly cookies prevent XSS attacks
8. **Rate Limiting**: Consider adding rate limiting for production

## Error Handling

Errors are handled consistently:

- **Validation Errors**: Returned with `400` status
- **Authentication Errors**: Returned with `401` status
- **Authorization Errors**: Returned with `403` status
- **Not Found**: Returned with `404` status
- **Server Errors**: Returned with `500` status

Error response format:
```json
{
  "error": "Error message description"
}
```

## Database Models

Mongoose models define the database schema:

- **User**: User accounts and authentication
- **CarIntake**: Car intake records
- **Inventory**: Inventory items
- **Buyer/Seller**: Buyer and seller entities
- **Waiver**: Waiver documents
- **Transaction**: Financial transactions
- **Invoice**: Invoice records
- **Part**: Parts catalog
- **Elements**: Element management
- **ElementHub**: Element hub tracking

Models are defined in `models/` directory. Refer to individual model files for schema details.

## Operational Scripts

### Seed Automation Bot

Create the automation bot service account:

```bash
npm run seed:automation-bot
```

Or run directly:
```bash
node scripts/seedAutomationBot.js
```

See `scripts/` for other one-off operational scripts (inventory bulk-add, eBay sync recovery/verification, data migrations, etc.).

## Testing

Currently, the project does not have automated tests configured. For production readiness, consider adding:

- Unit tests (Jest, Mocha)
- Integration tests (Supertest)
- API endpoint tests
- Database model tests

## Deployment

### Pre-Deployment Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure production MongoDB connection string
- [ ] Set strong `JWT_SECRET`
- [ ] Configure `CLIENT_URL` for production frontend
- [ ] Set up email service credentials (if using)
- [ ] Configure file upload storage (consider cloud storage)
- [ ] Set up process manager (PM2, systemd, Docker)
- [ ] Configure reverse proxy (nginx) if needed
- [ ] Set up monitoring and logging
- [ ] Configure SSL/TLS certificates
- [ ] Set up database backups
- [ ] Test all critical endpoints

### Deployment Steps

1. **Clone repository** on server
2. **Install dependencies**: `npm install`
3. **Set environment variables**: Create `.env` with production values
4. **Run migrations/seeds**: `npm run seed:automation-bot` (if needed)
5. **Start server**: `npm start` or use PM2/systemd
6. **Verify health**: Check server logs and test endpoints
7. **Configure frontend**: Update frontend `VITE_API_BASE_URL` to backend URL

### Docker Deployment (Example)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5000
CMD ["node", "server.js"]
```

## Monitoring & Maintenance

### Health Checks

Implement health check endpoint:

```javascript
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});
```

### Logging

- Monitor application logs for errors
- Set up log aggregation (e.g., ELK stack, CloudWatch)
- Monitor database connection status
- Track API response times

### Database Maintenance

- Regular MongoDB backups
- Monitor database size and performance
- Index optimization
- Clean up old/unused data periodically

## Troubleshooting

### Common Issues

1. **MongoDB Connection Failed**:
   - Verify MongoDB is running
   - Check `MONGODB_URI` is correct
   - Verify network connectivity
   - Check MongoDB authentication credentials

2. **JWT Authentication Errors**:
   - Verify `JWT_SECRET` is set
   - Check token expiration
   - Verify cookie settings (httpOnly, secure, sameSite)

3. **CORS Errors**:
   - Verify `CLIENT_URL` matches frontend URL
   - Check CORS middleware configuration

4. **File Upload Issues**:
   - Verify `UPLOAD_DIR` exists and has write permissions
   - Check `MAX_FILE_SIZE` configuration
   - Verify Multer configuration

5. **Port Already in Use**:
   - Change `PORT` in `.env`
   - Kill process using the port: `lsof -ti:5000 | xargs kill`

## Additional Resources

- **API Documentation**: `API_DOCS.md` - Complete API reference
- **Express.js Documentation**: https://expressjs.com/
- **Mongoose Documentation**: https://mongoosejs.com/
- **JWT Documentation**: https://jwt.io/

## Contributing

When contributing to the backend:

1. Follow existing code structure and patterns
2. Add request validation for all inputs
3. Implement proper error handling
4. Add authentication/authorization checks where needed
5. Update API documentation (`API_DOCS.md`) for new endpoints
6. Test endpoints with Postman or similar tools
7. Follow security best practices
8. Add logging for important operations

## License


