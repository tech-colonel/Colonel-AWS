# CFO Dashboard - Amazon  Agent Implementation

## 📊 Overview

The CFO Dashboard is a comprehensive financial analytics and business intelligence tool designed specifically for the Sales-Amazon agent. It provides Brand Managers and CFOs with real-time insights into sales performance, tax liability, product performance, and GST compliance.

## 🏗️ Architecture

### Backend Stack
- **Service**: `cfoAnalyticsService.js` - Core analytics logic
- **Controller**: `cfoAnalyticsController.js` - Request handlers
- **Routes**: `cfoAnalyticsRoutes.js` - API endpoints
- **Database**: PostgreSQL brand-specific databases for aggregation

### Frontend Stack
- **Main Dashboard**: `AmazonCFODashboard.jsx` - Complete dashboard UI
- **Launcher**: `CFODashboardLauncher.jsx` - Modal/integration component
- **Integration**: Embedded in `AgentWorkspace.jsx` and `BrandFinancialDetails.jsx`

### Supported Frameworks
- React 18+
- Recharts for visualizations
- React Query / Custom Hooks for data fetching
- TailwindCSS + shadcn/ui components

---

## 📡 API Endpoints

### 1. Complete Dashboard Snapshot
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard`

Returns all dashboard metrics in a single request. Optimal for initial page load.

**Query Parameters:**
- `startDate` (optional): ISO date format (YYYY-MM-DD)
- `endDate` (optional): ISO date format (YYYY-MM-DD)

**Response:**
```json
{
  "summary": {
    "total_revenue": 1500000.00,
    "total_tax": 270000.00,
    "total_cgst": 90000.00,
    "total_sgst": 90000.00,
    "total_igst": 90000.00,
    "total_units": 5000,
    "transaction_count": 250,
    "refund_count": 15,
    "refund_rate": "6.00"
  },
  "stateWiseSales": [...],
  "topProducts": [...],
  "taxAnalysis": {...},
  "refundAnalysis": {...},
  "discountAnalysis": {...},
  "paymentMethods": [...],
  "gstCompliance": {...},
  "monthlyTrend": [...]
}
```

### 2. Summary Metrics
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/summary`

Returns total revenue, tax, transactions, and refunds.

### 3. State-wise Sales
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/state-wise-sales`

Returns revenue, tax, and transaction count grouped by shipping state.

### 4. Top Products
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/top-products`

**Query Parameters:**
- `limit` (optional): Default 10

Returns top N products by revenue with units sold and average price.

### 5. Tax Analysis
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/tax-analysis`

Returns detailed tax breakdown:
- Item taxes (CGST, SGST, IGST)
- Shipping taxes
- TCS (Tax Collected at Source)

### 6. Refund Analysis
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/refund-analysis`

Returns shipment vs refund comparison with impact on revenue and tax.

### 7. Discount Analysis
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/discount-analysis`

Returns discount breakdown:
- Item discounts
- Shipping discounts
- Discount as percentage of revenue

### 8. Payment Methods
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/payment-methods`

Returns revenue and transaction count by payment method.

### 9. GST Compliance Status  
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/gst-compliance`

Returns IRN filing status breakdown with percentages.

### 10. Monthly Trend
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/monthly-trend`

Returns monthly revenue, tax, and transaction count for trend analysis.

### 11. Detailed Transactions (Drill-down)
**GET** `/api/brands/:brandId/agents/:agentId/cfo-dashboard/transactions`

**Query Parameters:**
- `startDate` (optional): ISO date format
- `endDate` (optional): ISO date format
- `limit` (optional): Default 100
- `offset` (optional): Pagination
- `state` (optional): Filter by shipping state
- `sku` (optional): Filter by product SKU
- `transaction_type` (optional): "Shipment" or "Refund"

Returns paginated detailed transaction records.

---

## 🎨 Frontend Features

### 1. Dashboard Layout
- **Header**: Title, refresh button, export to Excel
- **Date Range Picker**: Custom date range filtering
- **KPI Cards**: Clickable cards for quick drill-down
  - Total Revenue
  - Total Tax Liability
  - Total Units
  - Average Order Value

### 2. Tabbed Interface

#### Overview Tab
- **Revenue & Tax Trend** (Line Chart)
  - Monthly revenue and tax visualization
  - Hover tooltips with exact values
- **Payment Method Distribution** (Pie + Cards)
  - Visual breakdown of payment methods
  - Clickable cards to drill down

#### Products Tab
- **Top 10 Products by Revenue** (Bar Chart + Cards)
  - Horizontal bar chart for easy comparison
  - Detailed cards showing:
    - Product name and SKU
    - Total revenue
    - Units sold
    - Average selling price
  - Click any product to view all transactions

#### Geography Tab
- **State-wise Sales Distribution** (Bar Chart + Cards)
  - Revenue by shipping state
  - Tax impact by state
  - Transaction count
  - Click to drill down by state

#### Compliance Tab
- **GST Compliance Status** (Pie Chart + Tables)
  - IRN filing status breakdown
  - Percentage of compliant transactions
- **Tax Breakdown** (Card Grid)
  - Item-wise taxes (CGST, SGST, IGST)
  - Shipping taxes
  - Total TCS

#### Analysis Tab
- **Refund & Return Analysis**
  - Shipments vs Refunds comparison
  - Impact on revenue and tax
  - Refund rate percentage
- **Discount Analysis**
  - Item, shipping, and gift wrap discounts
  - Discount as % of revenue
  - Click to view discounted transactions

### 3. Drill-down Modal
Clicking on any metric opens a transactions details modal:
- Displays up to 1000 transactions
- Shows key columns: Invoice, Order ID, Product, Quantity, Revenue, Tax, Date
- Can be filtered by additional criteria
- Sortable and searchable

### 4. Export Functionality
- **Export to Excel**: Creates multi-sheet workbook
  - Summary sheet with key metrics
  - State-wise sales
  - Top products
  - Tax analysis breakdown
  - Refund analysis
  - Payment methods
  - Monthly trends
- Filename: `CFO_Dashboard_Amazon_DD-MMM-YYYY.xlsx`

---

## 🔧 Usage Examples

### Access from Agent Workspace
```jsx
In /brands/{brandId}/agents/{agentId}:
1. Look for "Financial Analytics" card
2. Click "📊 CFO Dashboard" button
3. Dashboard opens in a modal
```

### Access from CFO Page
```
URL: /cfo/brands/{brandId}/agents/{agentId}/dashboard
```

### API Call Example
```javascript
// Fetch complete dashboard for date range
const response = await fetch(
  `/api/brands/abc123/agents/xyz789/cfo-dashboard?startDate=2024-01-01&endDate=2024-12-31`,
  {
    headers: { Authorization: `Bearer ${token}` }
  }
);

const data = await response.json();
console.log(data.summary); // Total revenue, tax, etc.
```

---

## 📊 Key Metrics Explained

### Summary Metrics
- **Total Revenue**: Sum of `final_amount_receivable` (includes all charges)
- **Total Tax Liability**: CGST + SGST + IGST (item + shipping)
- **Total Units**: Sum of quantity (negative for refunds)
- **Refund Rate**: (Refund Count / Transaction Count) × 100
- **Avg Order Value**: Total Revenue / Transaction Count

### Tax Analysis
- **Item Taxes**: Calculated on product price
- **Shipping Taxes**: Calculated on shipping amount
- **TCS**: Tax Collected at Source on payments
- Formula: Item Tax + Shipping Tax + TCS = Total Tax Liability

### State-wise Analysis
- Groups by `ship_to_state`
- Calculates revenue and tax per state
- Helps identify high-performing regions
- Maps to tally ledgers for accounting

### Product Performance
- Top 10 by revenue
- Shows units sold and average price
- SKU master linked for easy reconciliation
- Click to see all transactions for that SKU

### Refund Impact
- Refund quantity stored as negative (Refund flag sets negative quantity)
- Shows revenue lost and tax impact
- Helps calculate return rates by product

---

## 🔐 Access Control

### Role-based Access
- **Admin**: Full access to all dashboards
- **CFO**: Full access to CFO dashboards
- **Accountant**: Can access dashboard for assigned brands/agents
- **Brand Executive**: (Future) Brand-level dashboard

### Permission Checks
```javascript
// Routes protected by:
authorize('admin', 'cfo', 'accountant')
```

---

## 🎯 Daily Use Cases

### For Brand Manager
1. **Quick Health Check**: View summary KPIs
2. **Top Performers**: Check top products and states
3. **Refund Analysis**: Monitor return rates
4. **Discount Tracking**: Verify promotional impact
5. **Month-end Report**: Export dashboard data

### For CFO
1. **Tax Compliance**: Check GST filing status
2. **Revenue Projection**: View monthly trends
3. **Tax Planning**: Breakdown by tax type
4. **State-wise Liability**: Plan state-level GST
5. **Drill-down Analysis**: Review specific transactions for audits

### For Finance Team
1. **Payment Reconciliation**: By payment method
2. **Invoice Matching**: Check IRN status
3. **Discount Approval**: Review promo impact
4. **Return Processing**: Analyze refunds by product/state
5. **Compliance Reports**: Export for auditors

---

## 📈 Data Aggregation Flow

```
Raw Transaction Data (Amazon Agent Table)
    ↓
Filtered by Date Range (startDate, endDate)
    ↓
Aggregated by:
  - State (for geography)
  - SKU (for products)
  - Payment Method (for payment analysis)
  - Month (for trends)
  - IRN Status (for compliance)
    ↓
Formatted & Returned via API
    ↓
Visualized in React Components
    ↓
Exportable to Excel
```

---

## ⚙️ Configuration & Customization

### Adding New Metrics
1. Add aggregation function in `cfoAnalyticsService.js`
2. Add controller method in `cfoAnalyticsController.js`
3. Add API route in `cfoAnalyticsRoutes.js`
4. Add UI component in `AmazonCFODashboard.jsx`

### Changing Colors
In `AmazonCFODashboard.jsx`:
```javascript
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042']; // Modify array
```

### Switching Charts
- Replaces chart library: Update Recharts imports
- Chart types: LineChart, BarChart, PieChart, AreaChart supported
- Responsive: All charts use ResponsiveContainer

---

## 🐛 Troubleshooting

### Dashboard Not Loading
1. Check backend API is running
2. Verify authentication token is valid
3. Check browser console for errors
4. Confirm brandId and agentId are valid

### Data Shows Empty
1. Verify data was uploaded to agent
2. Check date range includes data
3. Ensure master data (SKU/Ledger) is uploaded
4. Check database for records

### Export Fails
1. Verify XLSX library is installed
2. Check browser file download permissions
3. Ensure sufficient disk space

### Charts Not Showing
1. Verify Recharts is installed
2. Check data format matches chart expectations
3. Confirm date range has data
4. Check for console JavaScript errors

---

## 📝 Notes

- All monetary values are in rupees (₹)
- Negative quantities indicate refunds
- Dates are in ISO format (YYYY-MM-DD)
- Tax calculations follow Indian GST standards
- State mapping uses Tally ledger names for accounting integration
- TCS applies to certain payment methods based on amount

---

## 🔄 Future Enhancements

1. **Real-time Data**: WebSocket updates
2. **Custom Date Ranges**: Preset periods (Last 7 days, etc.)
3. **Forecasting**: ML-based revenue projections
4. **Alerts**: Thresholds for anomalies
5. **Multi-agent Comparison**: Side-by-side analysis
6. **Custom Reports**: User-defined metric combinations
7. **Scheduled Exports**: Automatic email reports
8. **Mobile Dashboard**: Responsive mobile view

---

## ✅ Checklist

Before going to production:

- [ ] Backend APIs tested with postman
- [ ] Frontend components render correctly
- [ ] Date range filtering works
- [ ] Drill-down modals show correct data
- [ ] Export generates valid Excel files
- [ ] Mobile responsiveness tested
- [ ] Permissions/roles validated
- [ ] Performance tested with large datasets
- [ ] Error handling for edge cases
- [ ] User documentation provided
