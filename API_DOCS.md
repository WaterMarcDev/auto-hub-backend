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

## Car Intake Bulk Upload

The bulk upload API allows you to import multiple car intakes from an Excel spreadsheet in a single operation. The API accepts a file URL pointing to an Excel file in your uploads directory.

### Bulk Upload Car Intakes

- **POST** `/api/car-intake/bulk-upload`
- **Auth:** httpOnly cookie OR `Authorization: Bearer <token>`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "fileUrl": "/uploads/carlist-1234567890.xlsx"
}
```

**Note:** The `fileUrl` should be the path returned from the upload endpoint (e.g., `/uploads/filename.xlsx`).

**Excel Sheet Headers (Column Names):**

| Header                      | Required | Type           | Description                              | Example                    |
| --------------------------- | -------- | -------------- | ---------------------------------------- | -------------------------- |
| vin                         | Yes      | String         | Vehicle Identification Number (17 chars) | 1HGBH41JXMN109186          |
| Make                        | No       | String         | Vehicle manufacturer                     | Honda, Toyota, Ford        |
| Modal (or Model)            | No       | String         | Vehicle model                            | Civic, Camry, F-150        |
| Year                        | No       | Number         | Model year                               | 2020, 2019                 |
| trim                        | No       | String         | Trim level                               | EX, LE, XLT                |
| color                       | No       | String         | Vehicle color                            | Red, Blue, Silver          |
| Boday Class (or Body Class) | No       | String         | Body style                               | Sedan, SUV, Truck          |
| Engine                      | No       | String         | Engine specification                     | 2.0L I4, V6                |
| Transmission                | No       | String         | Transmission type (Automatic/Manual)     | Automatic, Manual          |
| Drive                       | No       | String         | Drive type (2WD/4WD/AWD/FWD)             | FWD, AWD, 4WD              |
| Fuel type (or Fuel Type)    | No       | String         | Fuel type                                | Gasoline, Diesel, Electric |
| Where (or Location)         | No       | String         | Storage location in yard                 | Lot A, Row 3, Bay 12       |
| Keys                        | No       | Boolean/String | Keys available (yes/no, true/false, 1/0) | yes, true, 1               |
| date In (or Date In)        | No       | Date           | Date car was received                    | 2025-10-01, 10/1/2025      |

**Important Notes:**

- **Only VIN is required**: All other fields are optional
- **Case-insensitive**: Headers can be in any case (e.g., "Make", "make", "MAKE")
- **Flexible naming**: "Modal" or "Model" both work for model, "Boday Class" or "Body Class" for body class
- **Date handling**: If "date In" is provided, it will be mapped to the `createdAt` timestamp
- **Graceful skipping**: Rows with missing VIN are skipped, not failed
- **Duplicate handling**: Cars with existing VINs are skipped automatically
- **Valid values**: Drive must be one of: 2WD, 4WD, AWD, FWD. Transmission must be: Automatic or Manual

**Example Request using cURL:**

```bash
curl -X POST http://localhost:5000/api/car-intake/bulk-upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fileUrl": "/uploads/car_intakes-1696420800000.xlsx"
  }'
```

**Example Request using JavaScript/Fetch:**

```javascript
// Step 1: Upload the Excel file first
const formData = new FormData();
formData.append("image", excelFile); // Field name is 'image'

const uploadResponse = await fetch("http://localhost:5000/api/upload/image", {
  method: "POST",
  headers: {
    Authorization: "Bearer YOUR_TOKEN",
  },
  body: formData,
});

const uploadData = await uploadResponse.json();
// uploadData.imageUrl will be something like "/uploads/image-1696420800000-car_intakes.xlsx"

// Step 2: Submit bulk upload with file URL
const bulkUploadResponse = await fetch(
  "http://localhost:5000/api/car-intake/bulk-upload",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer YOUR_TOKEN",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileUrl: uploadData.imageUrl,
    }),
  }
);

const result = await bulkUploadResponse.json();
console.log(result);
```

**Example Response:**

```json
{
  "message": "Bulk upload completed",
  "summary": {
    "total": 10,
    "successful": 7,
    "failed": 1,
    "skipped": 2
  },
  "results": {
    "successful": [
      {
        "row": 2,
        "vin": "1HGBH41JXMN109186",
        "car": "2020 Honda Civic",
        "id": "6523abc123def456789"
      },
      {
        "row": 3,
        "vin": "5YFBURHE5HP123456",
        "car": "2019 Toyota Camry",
        "id": "6523abc123def456790"
      }
    ],
    "failed": [
      {
        "row": 5,
        "reason": "VIN validation failed",
        "data": {
          "Make": "Ford",
          "Model": "F-150",
          "Year": 2021,
          "vin": "INVALID"
        }
      }
    ],
    "skipped": [
      {
        "row": 4,
        "reason": "Missing required fields (VIN, Make, Model, Year)",
        "data": {
          "Make": "Toyota",
          "Year": 2020
        }
      },
      {
        "row": 6,
        "reason": "VIN already exists",
        "vin": "1HGBH41JXMN109186"
      }
    ]
  }
}
```

**Error Responses:**

**No file URL provided:**

```json
{
  "error": "No file URL provided"
}
```

**File not found:**

```json
{
  "error": "File not found"
}
```

**Empty Excel file:**

```json
{
  "error": "Excel file is empty"
}
```

**Invalid file format:**

```json
{
  "error": "Server error during bulk upload",
  "details": "Invalid Excel file format"
}
```

**Server error:**

```json
{
  "error": "Server error during bulk upload",
  "details": "Error message details"
}
```

### Sample Excel File Structure

```
| Make  | Modal  | Year | trim | vin               | color  | Body Class | Engine    | Transmission | Drive | Fuel type | Where  | Keys | date In    |
|-------|--------|------|------|-------------------|--------|------------|-----------|--------------|-------|-----------|--------|------|------------|
| Honda | Civic  | 2020 | EX   | 1HGBH41JXMN109186| Silver | Sedan      | 2.0L I4   | Automatic    | FWD   | Gasoline  | Lot A  | yes  | 2025-10-01 |
| Toyota| Camry  | 2019 | LE   | 5YFBURHE5HP123456| White  | Sedan      | 2.5L I4   | Automatic    | FWD   | Gasoline  | Lot B  | true | 10/1/2025  |
| Ford  | F-150  | 2021 | XLT  | 1FTFW1E50MFA12345| Red    | Truck      | 3.5L V6   | Automatic    | 4WD   | Gasoline  | Row 3  | 1    | 2025-09-30 |
```

**Tips for Best Results:**

1. First upload the Excel file using `/api/upload/image` endpoint to get a file URL
2. Use the returned `imageUrl` (e.g., `/uploads/filename.xlsx`) in the bulk upload request
3. Ensure all VINs are unique and valid (17 characters)
4. Use consistent formatting for Make, Model, and Trim names
5. For dates, use standard formats like YYYY-MM-DD or MM/DD/YYYY
6. For boolean fields (Keys), use: yes/no, true/false, or 1/0
7. Verify Drive and Transmission values match allowed values
8. Test with a small batch first before uploading large files

**Workflow:**

1. **Upload Excel file** → POST `/api/upload/image` with file
2. **Get file URL** → Response contains `imageUrl` field (e.g., `/uploads/file-123.xlsx`)
3. **Bulk import** → POST `/api/car-intake/bulk-upload` with `fileUrl` in body
4. **Review results** → Check successful, failed, and skipped records
