# Sendmode SMS REST API (v3.0) — AI Reference

This document specifies the **Sendmode SMS REST API v3.0**. It is structured for unambiguous parsing by AI agents, LLM tool-calling systems, and code generators.

---

## 1. API Overview

- **Base URL:** `https://sms-rest.sendmode.dev`
- **API Version:** `3.0` (all paths begin with `/3.0/`)
- **Data Format:** JSON (`Content-Type: application/json` required for all requests with a body)
- **Authentication:** Pass the API access key directly in the `Authorization` HTTP header.

```http
Authorization: {ACCESS_KEY}
```

> **Important for AI / Code Generators:**
> - Do **not** prepend `Bearer ` or `Basic ` to the `Authorization` header unless explicitly configured otherwise; pass `{ACCESS_KEY}` directly.
> - `DELETE /3.0/schedule` requires a **JSON request body** (not a URL path parameter or query string).
> - All timestamps use **ISO 8601 UTC** format (ending in `Z`).

---

## 2. Endpoint Summary

| Method | Path | Description | Request Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/3.0/balance` | Retrieve the current account SMS credit balance. | None |
| `POST` | `/3.0/send` | Send a single SMS immediately. | JSON |
| `POST` | `/3.0/send/bulk` | Send an SMS immediately to up to 100 recipients. | JSON |
| `POST` | `/3.0/schedule` | Schedule a single SMS for future delivery. | JSON |
| `POST` | `/3.0/schedule/bulk` | Schedule an SMS for future delivery to up to 100 recipients. | JSON |
| `DELETE` | `/3.0/schedule` | Cancel a previously scheduled SMS using its `request_id`. | JSON |

---

## 3. Global Validation Rules & Constraints

When constructing requests, enforce the following rules:

1. **`sender_id`**: String, 1 to 15 characters, must match regex `[^<>]*` (cannot contain `<` or `>`).
2. **`message`**: String, 1 to 1224 characters, must match regex `[^<>]*` (cannot contain `<` or `>`).
3. **`mobile_number` / `mobile_numbers`**: International format (e.g., `+353871234567`). Bulk arrays (`mobile_numbers`) accept a maximum of **100 items**.
4. **`schedule_date`**: ISO 8601 UTC date-time string (e.g., `2025-06-01T13:15:00Z`). Must be:
   - In **UTC** timezone.
   - Aligned to **15-minute intervals** (`:00`, `:15`, `:30`, or `:45` minutes, `:00` seconds).
   - At least **15 minutes in the future**.
5. **`customer_id`**: Optional, nullable string used for your own tracking; returned in webhook callbacks.
6. **`tags`**: Optional array of strings for reporting and segmentation.

---

## 4. Common Response Structure & Error Codes

Every endpoint returns a JSON object containing these base status fields:

| Field | Type | Description |
| :--- | :--- | :--- |
| `is_successful` | `boolean` | `true` if the request succeeded; `false` otherwise. |
| `error_message` | `string \| null` | Error description on failure; `null` on success. |
| `accept_date` | `string \| null` | ISO 8601 UTC timestamp when accepted; `null` on failure. |

### Common Error Responses (Applies to All Endpoints)

#### `400 Bad Request`
Returned when required JSON fields are missing or fail validation.
```json
{
  "is_successful": false,
  "error_message": "No valid [ ] found in request json.",
  "accept_date": null
}
```

#### `401 Unauthorized`
Returned when the `Authorization` header is missing or contains an invalid access key.
```json
{
  "is_successful": false,
  "error_message": "No valid [acess_key] found in Authorization Header.",
  "accept_date": null
}
```

---

## 5. Endpoints

### 5.1 Get Account Balance

**`GET /3.0/balance`**

Retrieves the current available SMS balance for the authenticated account.

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)

#### Request Body
None.

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/balance", {
  method: "GET",
  headers: {
    "Authorization": `${ACCESS_KEY}`
  }
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `balance` | `number` | Current remaining account balance. |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "balance": 100,
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:04:55.7530548Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).

---

### 5.2 Send Single SMS

**`POST /3.0/send`**

Sends an SMS message immediately to a single mobile number.

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)
- `Content-Type: application/json` (Required)

#### Request Body Schema
| Field | Type | Required | Constraints | Example | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sender_id` | `string` | Yes | `minLength: 1`, `maxLength: 15`, `pattern: [^<>]*` | `"SM Testing"` | Alphanumeric sender ID or name displayed as the SMS sender. |
| `message` | `string` | Yes | `minLength: 1`, `maxLength: 1224`, `pattern: [^<>]*` | `"Hello World"` | SMS text content. |
| `mobile_number` | `string` | Yes | `minLength: 1` | `"+353871234567"` | Destination mobile number in international format. |
| `customer_id` | `string \| null` | No | — | `"my-id-1234"` | Custom tracking identifier returned in webhook callbacks. |
| `tags` | `array<string>` | No | — | `["Sale", "X-Mas"]` | Optional labels for reporting and segmentation. |

#### Request Body Example
```json
{
  "sender_id": "SM Testing",
  "message": "Hello World",
  "mobile_number": "+353871234567",
  "customer_id": "my-id-1234",
  "tags": ["Sale", "X-Mas"]
}
```

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/send", {
  method: "POST",
  headers: {
    "Authorization": `${ACCESS_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    sender_id: "SM Testing",
    message: "Hello World",
    mobile_number: "+353871234567",
    customer_id: "my-id-1234",
    tags: ["Sale", "X-Mas"]
  })
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `request_id` | `string` | UUID identifying the SMS send request. |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "request_id": "eb2cb83f-9f36-4ff7-81a7-0bbe85f64015",
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:19:42.8589395Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).

---

### 5.3 Send Bulk SMS

**`POST /3.0/send/bulk`**

Sends the same SMS message immediately to multiple recipients (up to 100 mobile numbers per request).

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)
- `Content-Type: application/json` (Required)

#### Request Body Schema
| Field | Type | Required | Constraints | Example | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sender_id` | `string` | Yes | `minLength: 1`, `maxLength: 15`, `pattern: [^<>]*` | `"SM Testing"` | Alphanumeric sender ID or name displayed as the SMS sender. |
| `message` | `string` | Yes | `minLength: 1`, `maxLength: 1224`, `pattern: [^<>]*` | `"Hello World"` | SMS text content. |
| `mobile_numbers` | `array<string>` | Yes | `maxItems: 100` | `["+353871234567", "+353871234568"]` | Destination mobile numbers in international format. |
| `customer_id` | `string \| null` | No | — | `"my-id-1234"` | Custom tracking identifier returned in webhook callbacks. |
| `tags` | `array<string>` | No | — | `["Sale", "X-Mas"]` | Optional labels for reporting and segmentation. |

#### Request Body Example
```json
{
  "sender_id": "SM Testing",
  "message": "Hello World",
  "customer_id": "my-id-1234",
  "tags": ["Sale", "X-Mas"],
  "mobile_numbers": [
    "+353871234567",
    "+353871234568"
  ]
}
```

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/send/bulk", {
  method: "POST",
  headers: {
    "Authorization": `${ACCESS_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    sender_id: "SM Testing",
    message: "Hello World",
    mobile_numbers: ["+353871234567", "+353871234568"],
    customer_id: "my-id-1234",
    tags: ["Sale", "X-Mas"]
  })
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `invalid_mobile_numbers` | `array<string>` | List of any submitted mobile numbers that were invalid and skipped. |
| `request_id` | `string` | UUID identifying the bulk send request. |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "invalid_mobile_numbers": [],
  "request_id": "5f25f12f-e9c6-44b8-aae3-71f6eceb8f6d",
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:19:42.8625877Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).

---

### 5.4 Schedule Single SMS

**`POST /3.0/schedule`**

Schedules a single SMS message to be sent at a future UTC date and time.

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)
- `Content-Type: application/json` (Required)

#### Request Body Schema
| Field | Type | Required | Constraints | Example | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sender_id` | `string` | Yes | `minLength: 1`, `maxLength: 15`, `pattern: [^<>]*` | `"SM Testing"` | Alphanumeric sender ID or name displayed as the SMS sender. |
| `message` | `string` | Yes | `minLength: 1`, `maxLength: 1224`, `pattern: [^<>]*` | `"Hello World"` | SMS text content. |
| `mobile_number` | `string` | Yes | `minLength: 1` | `"+353871234567"` | Destination mobile number in international format. |
| `schedule_date` | `string (date-time)` | Yes | UTC only, 15-minute intervals, at least 15 minutes in the future | `"2025-06-01T13:15:00Z"` | Scheduled delivery date and time in ISO 8601 UTC format. |
| `customer_id` | `string \| null` | No | — | `"my-id-1234"` | Custom tracking identifier returned in webhook callbacks. |
| `tags` | `array<string>` | No | — | `["Sale", "X-Mas"]` | Optional labels for reporting and segmentation. |

#### Request Body Example
```json
{
  "sender_id": "SM Testing",
  "message": "Hello World",
  "customer_id": "my-id-1234",
  "tags": ["Sale", "X-Mas"],
  "mobile_number": "+353871234567",
  "schedule_date": "2025-06-01T13:15:00Z"
}
```

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/schedule", {
  method: "POST",
  headers: {
    "Authorization": `${ACCESS_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    sender_id: "SM Testing",
    message: "Hello World",
    mobile_number: "+353871234567",
    schedule_date: "2025-06-01T13:15:00Z",
    customer_id: "my-id-1234",
    tags: ["Sale", "X-Mas"]
  })
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `request_id` | `string` | UUID identifying the scheduled SMS (use this ID with `DELETE /3.0/schedule` to cancel). |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "request_id": "7117cba3-23f0-469a-8253-c50f0270ef34",
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:04:55.865397Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).

---

### 5.5 Schedule Bulk SMS

**`POST /3.0/schedule/bulk`**

Schedules an SMS message to be sent to multiple recipients (up to 100 mobile numbers) at a future UTC date and time.

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)
- `Content-Type: application/json` (Required)

#### Request Body Schema
| Field | Type | Required | Constraints | Example | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sender_id` | `string` | Yes | `minLength: 1`, `maxLength: 15`, `pattern: [^<>]*` | `"SM Testing"` | Alphanumeric sender ID or name displayed as the SMS sender. |
| `message` | `string` | Yes | `minLength: 1`, `maxLength: 1224`, `pattern: [^<>]*` | `"Hello World"` | SMS text content. |
| `mobile_numbers` | `array<string>` | Yes | `maxItems: 100` | `["+353871234567", "+353871234568"]` | Destination mobile numbers in international format. |
| `schedule_date` | `string (date-time)` | Yes | UTC only, 15-minute intervals, at least 15 minutes in the future | `"2025-06-01T13:15:00Z"` | Scheduled delivery date and time in ISO 8601 UTC format. |
| `customer_id` | `string \| null` | No | — | `"my-id-1234"` | Custom tracking identifier returned in webhook callbacks. |
| `tags` | `array<string>` | No | — | `["Sale", "X-Mas"]` | Optional labels for reporting and segmentation. |

#### Request Body Example
```json
{
  "sender_id": "SM Testing",
  "message": "Hello World",
  "customer_id": "my-id-1234",
  "tags": ["Sale", "X-Mas"],
  "mobile_numbers": [
    "+353871234567",
    "+353871234568"
  ],
  "schedule_date": "2025-06-01T13:15:00Z"
}
```

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/schedule/bulk", {
  method: "POST",
  headers: {
    "Authorization": `${ACCESS_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    sender_id: "SM Testing",
    message: "Hello World",
    mobile_numbers: ["+353871234567", "+353871234568"],
    schedule_date: "2025-06-01T13:15:00Z",
    customer_id: "my-id-1234",
    tags: ["Sale", "X-Mas"]
  })
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `invalid_mobile_numbers` | `array<string>` | List of any submitted mobile numbers that were invalid and skipped. |
| `request_id` | `string` | UUID identifying the scheduled bulk SMS (use this ID with `DELETE /3.0/schedule` to cancel). |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "invalid_mobile_numbers": [],
  "request_id": "e25349bb-c9b4-4e04-b661-2af63675bdcd",
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:04:55.8691331Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).

---

### 5.6 Cancel Scheduled SMS

**`DELETE /3.0/schedule`**

Cancels a previously scheduled single or bulk SMS job before delivery using its `request_id`.

#### Headers
- `Authorization: {ACCESS_KEY}` (Required)
- `Content-Type: application/json` (Required)

#### Request Body Schema
| Field | Type | Required | Constraints | Example | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `request_id` | `string` | Yes | — | `"04b137ef-b22d-447c-b9c2-f4b9e31d6169"` | The `request_id` returned when the schedule was created. |

#### Request Body Example
```json
{
  "request_id": "04b137ef-b22d-447c-b9c2-f4b9e31d6169"
}
```

#### Example Request (JavaScript)
```javascript
const response = await fetch("https://sms-rest.sendmode.dev/3.0/schedule", {
  method: "DELETE",
  headers: {
    "Authorization": `${ACCESS_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    request_id: "04b137ef-b22d-447c-b9c2-f4b9e31d6169"
  })
});
const data = await response.json();
```

#### Response (`200 OK`)
| Field | Type | Description |
| :--- | :--- | :--- |
| `is_successful` | `boolean` | `true` on success. |
| `error_message` | `string \| null` | `null` on success. |
| `accept_date` | `string` | ISO 8601 UTC acceptance timestamp. |

```json
{
  "is_successful": true,
  "error_message": null,
  "accept_date": "2025-08-25T08:04:55.8670268Z"
}
```

*Error responses:* `400 Bad Request`, `401 Unauthorized` (see [Section 4](#4-common-response-structure--error-codes)).