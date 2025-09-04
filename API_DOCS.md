# AutoHub API Documentation

## 🔐 Authentication Overview

This API uses **httpOnly cookies** for secure authentication. After login, the JWT token is stored in an httpOnly cookie that is automatically sent with requests. The API also supports Authorization headers as a fallback.

## Authentication Endpoints

### Register User

- **POST** `/api/auth/register`
- **Body:**

```json
{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "password": "SecurePass123!",
  "role": "staff" // optional, defaults to "staff"
}
```

- **Note:** Registration does NOT return a token. Users must login after registration.

### Login User

- **POST** `/api/auth/login`
- **Body:**

```json
{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

- **Note:** Sets an httpOnly cookie with JWT token for security

### Logout User

- **POST** `/api/auth/logout`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`
- **Note:** Clears the authentication cookie

### Get Profile

- **GET** `/api/auth/profile`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`

## User Management (Admin Only)

### Get All Users

- **GET** `/api/users`
- **Headers:** `Authorization: Bearer <admin_token>`

### Get User by ID

- **GET** `/api/users/:id`
- **Headers:** `Authorization: Bearer <admin_token>`

### Update User

- **PUT** `/api/users/:id`
- **Headers:** `Authorization: Bearer <admin_token>`
- **Body:**

```json
{
  "first_name": "Updated Name",
  "last_name": "Updated Last",
  "email": "updated@example.com",
  "role": "admin"
}
```

### Delete User

- **DELETE** `/api/users/:id`
- **Headers:** `Authorization: Bearer <admin_token>`

## Default Admin User

- **Email:** admin@autohub.com
- **Password:** Admin123!
- **Role:** admin

Run `npm run seed:admin` to create the default admin user.

## Password Requirements

- Minimum 6 characters
- At least one lowercase letter
- At least one uppercase letter
- At least one number

## Available Roles

- `admin` - Full access to all endpoints
- `staff` - Limited access (can access profile only)

## VIN Decoder API

The VIN decoder API allows you to fetch detailed vehicle information using a Vehicle Identification Number (VIN). It uses the NHTSA VPIC (Vehicle Product Information Catalog) database.

### Get VIN Details (GET)

- **GET** `/api/vin/:vinNumber`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`
- **Parameters:**
  - `vinNumber` (string, 17 characters): The VIN to decode

**Example Request:**

```
GET /api/vin/1HGBH41JXMN109186
```

**Example Response:**

```json
{
  "success": true,
  "vinNumber": "1HGBH41JXMN109186",
  "data": {
    "make": "HONDA",
    "model": "Civic",
    "year": "1991",
    "vehicleType": "PASSENGER CAR",
    "bodyClass": "Two Door",
    "engineModel": "D15B7",
    "cylinders": "4",
    "displacement": "1.5",
    "fuelType": "Gasoline",
    "transmission": "Manual",
    "driveType": "Front Wheel Drive",
    "manufacturer": "HONDA OF AMERICA MFG., INC.",
    "plantCountry": "UNITED STATES"
  },
  "source": "NHTSA VPIC Database",
  "timestamp": "2025-09-03T10:30:00.000Z"
}
```

### Decode VIN (POST)

- **POST** `/api/vin/decode`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`
- **Body:**

```json
{
  "vinNumber": "1HGBH41JXMN109186",
  "includeRawData": false
}
```

**Parameters:**

- `vinNumber` (string, required): The VIN to decode (17 characters)
- `includeRawData` (boolean, optional): Include raw API response data

**Example Response:**

```json
{
  "success": true,
  "vinNumber": "1HGBH41JXMN109186",
  "data": {
    "make": "HONDA",
    "model": "Civic",
    "year": "1991",
    "vehicleType": "PASSENGER CAR",
    "bodyClass": "Two Door",
    "engineModel": "D15B7",
    "cylinders": "4",
    "displacement": "1.5",
    "fuelType": "Gasoline",
    "transmission": "Manual",
    "driveType": "Front Wheel Drive",
    "manufacturer": "HONDA OF AMERICA MFG., INC.",
    "plantCountry": "UNITED STATES"
  },
  "source": "NHTSA VPIC Database",
  "timestamp": "2025-09-03T10:30:00.000Z"
}
```

### Check VIN Service Health

- **GET** `/api/vin/health`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`

**Example Response:**

```json
{
  "status": "healthy",
  "service": "NHTSA VPIC API",
  "timestamp": "2025-09-03T10:30:00.000Z",
  "testVin": "1HGBH41JXMN109186",
  "responseTime": "< 5s"
}
```

### VIN API Error Responses

**Invalid VIN Format:**

```json
{
  "error": "Invalid VIN format. VIN must be 17 characters long and contain only valid characters (no I, O, or Q)."
}
```

**VIN Not Found/Invalid:**

```json
{
  "error": "VIN could not be decoded",
  "details": "Check Digit (9th position) does not calculate properly",
  "vinNumber": "INVALID_VIN_NUMBER"
}
```

**Service Unavailable:**

```json
{
  "error": "VIN service temporarily unavailable. Please try again later."
}
```

**Timeout:**

```json
{
  "error": "VIN lookup request timed out. Please try again."
}
```

### VIN Format Requirements

- Must be exactly 17 characters long
- Can contain letters A-Z and numbers 0-9
- Cannot contain the letters I, O, or Q (to avoid confusion with numbers)
- Case insensitive (automatically converted to uppercase)

### Data Fields Returned

The API returns the following vehicle information when available:

- **make**: Vehicle manufacturer (e.g., "HONDA", "TOYOTA")
- **model**: Vehicle model (e.g., "Civic", "Camry")
- **year**: Model year
- **vehicleType**: Type of vehicle (e.g., "PASSENGER CAR", "TRUCK")
- **bodyClass**: Body style (e.g., "Two Door", "Four Door", "SUV")
- **engineModel**: Engine model designation
- **engineConfiguration**: Engine configuration (e.g., "V", "In-Line")
- **cylinders**: Number of engine cylinders
- **displacement**: Engine displacement in liters
- **fuelType**: Primary fuel type (e.g., "Gasoline", "Diesel", "Electric")
- **transmission**: Transmission type (e.g., "Manual", "Automatic")
- **driveType**: Drive configuration (e.g., "Front Wheel Drive", "All Wheel Drive")
- **manufacturer**: Manufacturing company name
- **plantCountry**: Country where vehicle was manufactured
- **trim**: Vehicle trim level (when available)
- **series**: Vehicle series (when available)

_Note: Not all fields may be available for every VIN, depending on the vehicle and data availability in the NHTSA database._
