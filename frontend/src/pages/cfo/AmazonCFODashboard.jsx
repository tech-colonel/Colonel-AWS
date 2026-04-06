import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import api from '@/lib/api';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658'];

const CFODashboardAmazon = ({ brandId, agentId, initialStartMonth = '', initialStartYear = '', initialEndMonth = '', initialEndYear = '' }) => {
  const initialStartDate = initialStartMonth && initialStartYear ? `${initialStartYear}-${String(initialStartMonth).padStart(2, '0')}-01` : null;
  const initialEndDate = initialEndMonth && initialEndYear ? `${initialEndYear}-${String(initialEndMonth).padStart(2, '0')}-${new Date(parseInt(initialEndYear), parseInt(initialEndMonth), 0).getDate()}` : null;

  const [startDate, setStartDate] = useState(initialStartDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const [sku, setSku] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Dashboard Data State
  const [dashboardData, setDashboardData] = useState({
    agentName: '',
    summary: null,
    stateWiseSales: [],
    topProducts: [],
    taxAnalysis: null,
    refundAnalysis: null,
    discountAnalysis: null,
    paymentMethods: [],
    gstCompliance: null,
    monthlyTrend: [],
    revenueMIS: [],
  });

  const [filtersOptions, setFiltersOptions] = useState([]);
  const [startMonth, setStartMonth] = useState(initialStartMonth);
  const [startYear, setStartYear] = useState(initialStartYear);
  const [endMonth, setEndMonth] = useState(initialEndMonth);
  const [endYear, setEndYear] = useState(initialEndYear);

  const uniqueYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let i = currentYear - 10; i <= currentYear + 10; i++) {
      years.push(i);
    }
    return years.sort((a, b) => b - a);
  }, []);

  const monthsList = [
    { value: 1, label: 'January' },
    { value: 2, label: 'February' },
    { value: 3, label: 'March' },
    { value: 4, label: 'April' },
    { value: 5, label: 'May' },
    { value: 6, label: 'June' },
    { value: 7, label: 'July' },
    { value: 8, label: 'August' },
    { value: 9, label: 'September' },
    { value: 10, label: 'October' },
    { value: 11, label: 'November' },
    { value: 12, label: 'December' }
  ];

  useEffect(() => {
    if (startMonth && startYear) {
      setStartDate(`${startYear}-${String(startMonth).padStart(2, '0')}-01`);
    } else {
      setStartDate(null);
    }
  }, [startMonth, startYear]);

  useEffect(() => {
    if (endMonth && endYear) {
      const lastDay = new Date(parseInt(endYear), parseInt(endMonth), 0).getDate();
      setEndDate(`${endYear}-${String(endMonth).padStart(2, '0')}-${lastDay}`);
    } else {
      setEndDate(null);
    }
  }, [endMonth, endYear]);

  // Modal State
  const [detailsModal, setDetailsModal] = useState({ open: false, data: [], title: '' });
  const [calculationModal, setCalculationModal] = useState({ open: false, type: '' });
  const [selectedTransaction, setSelectedTransaction] = useState(null);

  /**
   * Fetch all dashboard data
   */
  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      if (sku) params.append('sku', sku);

      // Fetch snapshot and MIS data in parallel
      const [snapshotRes, misRes] = await Promise.all([
        api.get(`/api/brands/${brandId}/agents/${agentId}/cfo-dashboard?${params.toString()}`),
        api.get(`/api/brands/${brandId}/agents/${agentId}/cfo-dashboard/revenue-mis?${params.toString()}`)
      ]);

      if (snapshotRes.data && misRes.data) {
        setDashboardData({
          ...snapshotRes.data,
          revenueMIS: misRes.data
        });
      }
    } catch (err) {
      setError(err.message || 'Failed to load dashboard data');
      console.error('Dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (brandId && agentId) {
      if (startDate && endDate) {
        fetchDashboardData();
      }

      // Fetch available filters (Months/Years)
      api.get(`/api/brands/${brandId}/agents/${agentId}/cfo-dashboard/filters`)
        .then(res => {
          if (res.data && res.data.filters) {
            setFiltersOptions(res.data.filters);
          }
        })
        .catch(err => console.error('Failed to load filters', err));
    }
  }, [brandId, agentId]);

  const misTotals = useMemo(() => {
    let misArray = dashboardData.revenueMIS || [];
    // Just in case the API wrapped the response in a 'data' object
    if (!Array.isArray(misArray) && misArray.data && Array.isArray(misArray.data)) {
      misArray = misArray.data;
    }

    if (!Array.isArray(misArray) || misArray.length === 0) {
      if (dashboardData.summary) {
        // Fallback to summary so that modals always show data even if MIS grouping is empty
        return {
          orders: dashboardData.summary.transaction_count || 0,
          units: { 
            gross: dashboardData.summary.total_units || 0, 
            returns: dashboardData.summary.refund_count || 0, 
            net: dashboardData.summary.total_units || 0 
          },
          sales: { 
            gross_inc_gst: dashboardData.summary.total_revenue || 0, 
            tax: dashboardData.summary.total_tax || 0, 
            net_sales: dashboardData.summary.total_revenue || 0, 
            returns: 0, 
            revenue_from_goods: dashboardData.summary.total_revenue || 0 
          }
        };
      }
      return null;
    }
    
    return misArray.reduce((acc, curr) => {
      acc.orders += curr.particulars?.orders || 0;
      acc.units.gross += curr.particulars?.units?.gross || 0;
      acc.units.returns += curr.particulars?.units?.returns || 0;
      acc.units.net += curr.particulars?.units?.net || 0;
      
      acc.sales.gross_inc_gst += curr.particulars?.sales?.gross_inc_gst || 0;
      acc.sales.tax += curr.particulars?.sales?.tax || 0;
      acc.sales.net_sales += curr.particulars?.sales?.net_sales || 0;
      acc.sales.returns += curr.particulars?.sales?.returns || 0;
      acc.sales.revenue_from_goods += curr.particulars?.sales?.revenue_from_goods || 0;
      
      return acc;
    }, {
      orders: 0,
      units: { gross: 0, returns: 0, net: 0 },
      sales: { gross_inc_gst: 0, tax: 0, net_sales: 0, returns: 0, revenue_from_goods: 0 }
    });
  }, [dashboardData.revenueMIS, dashboardData.summary]);

  /**
   * Format currency with 2 decimals
   */
  const formatCurrency = (value) => {
    return `₹${parseFloat(value || 0).toFixed(2)}`;
  };

  const formatNumber = (value) => {
    return parseInt(value || 0).toLocaleString('en-IN');
  };

  /**
   * Open details modal with transactions
   */
  const openDetailsModal = async (title, filters = {}) => {
    try {
      const params = new URLSearchParams({ limit: 1000, offset: 0 });
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });

      const response = await api.get(
        `/api/brands/${brandId}/agents/${agentId}/cfo-dashboard/transactions?${params.toString()}`
      );

      setDetailsModal({
        open: true,
        data: response.data.data || [],
        title,
      });
    } catch (err) {
      setError('Failed to load transaction details');
    }
  };

  /**
   * Export dashboard data to Excel
   */
  const exportToExcel = () => {
    try {
      const wb = XLSX.utils.book_new();

      // 1. Revenue MIS Sheet (Formatted Row-wise)
      if (dashboardData.revenueMIS && dashboardData.revenueMIS.length > 0) {
        const misRows = [
          ['Particulars', ...dashboardData.revenueMIS.map(m => m.month_label)],
          [dashboardData.agentName || 'Agent', ...dashboardData.revenueMIS.map(() => '')],
          ['No of Orders', ...dashboardData.revenueMIS.map(m => m.particulars.orders)],
          ['No. of Units', ...dashboardData.revenueMIS.map(() => '')],
          ['  Gross', ...dashboardData.revenueMIS.map(m => m.particulars.units.gross)],
          ['  Returns', ...dashboardData.revenueMIS.map(m => m.particulars.units.returns)],
          ['  No. of Units (Net of Sales Return)', ...dashboardData.revenueMIS.map(m => m.particulars.units.net)],
          ['Sales', ...dashboardData.revenueMIS.map(() => '')],
          ['  Gross Sales (Including GST)', ...dashboardData.revenueMIS.map(m => m.particulars.sales.gross_inc_gst)],
          ['  Tax', ...dashboardData.revenueMIS.map(m => m.particulars.sales.tax)],
          ['  Net Sales', ...dashboardData.revenueMIS.map(m => m.particulars.sales.net_sales)],
          ['  Returns', ...dashboardData.revenueMIS.map(m => m.particulars.sales.returns)],
          ['  Revenue from Sales of Goods', ...dashboardData.revenueMIS.map(m => m.particulars.sales.revenue_from_goods)],
          ['Average Order Value (Including GST)', ...dashboardData.revenueMIS.map(m => m.particulars.aov)]
        ];
        const misWs = XLSX.utils.aoa_to_sheet(misRows);

        // Add number formatting with commas to all numeric cells
        Object.keys(misWs).forEach(key => {
          if (key[0] === '!') return;
          if (misWs[key].v !== undefined && typeof misWs[key].v === 'number') {
            misWs[key].z = '#,##0';
          }
        });

        XLSX.utils.book_append_sheet(wb, misWs, 'Revenue MIS');
      }

      // Summary Sheet
      const summarySheet = XLSX.utils.json_to_sheet([dashboardData.summary || {}]);
      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

      // State-wise Sales Sheet
      const stateSheet = XLSX.utils.json_to_sheet(dashboardData.stateWiseSales || []);
      XLSX.utils.book_append_sheet(wb, stateSheet, 'State-wise Sales');

      // Top Products Sheet
      const productsSheet = XLSX.utils.json_to_sheet(dashboardData.topProducts || []);
      XLSX.utils.book_append_sheet(wb, productsSheet, 'Top Products');

      // Tax Analysis Sheet
      const taxSheet = XLSX.utils.json_to_sheet([dashboardData.taxAnalysis || {}]);
      XLSX.utils.book_append_sheet(wb, taxSheet, 'Tax Analysis');

      // Refund Analysis Sheet
      const refundSheet = XLSX.utils.json_to_sheet([dashboardData.refundAnalysis || {}]);
      XLSX.utils.book_append_sheet(wb, refundSheet, 'Refund Analysis');

      // Payment Methods Sheet
      const paymentSheet = XLSX.utils.json_to_sheet(dashboardData.paymentMethods || []);
      XLSX.utils.book_append_sheet(wb, paymentSheet, 'Payment Methods');

      // Monthly Trend Sheet
      const trendSheet = XLSX.utils.json_to_sheet(dashboardData.monthlyTrend || []);
      XLSX.utils.book_append_sheet(wb, trendSheet, 'Monthly Trend');

      const filename = `CFO_Revenue_MIS_${(dashboardData.agentName || 'Agent').replace(/\s+/g, '_')}_${format(new Date(), 'dd-MMM-yyyy')}.xlsx`;
      XLSX.writeFile(wb, filename);
    } catch (err) {
      setError('Failed to export Excel');
      console.error(err);
    }
  };

  return (
    <div className="space-y-6 px-2 md:px-6 pb-12 pt-2">
      {/* Action Buttons */}
      <div className="flex justify-end items-center mb-2">
        <div className="flex gap-2">
          <Button onClick={fetchDashboardData} disabled={loading} variant="outline" size="sm">
            {loading ? 'Refreshing...' : '↻ Refresh Data'}
          </Button>
          <Button onClick={exportToExcel} variant="default" size="sm" className="bg-green-600 hover:bg-green-700 text-white">
            📊 Download MIS Report
          </Button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Summary KPI Cards */}
      {dashboardData.summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card
            className="cursor-pointer hover:shadow-lg transition-all border-l-4 border-l-blue-500"
            onClick={() => setCalculationModal({ open: true, type: 'Revenue' })}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex justify-between">
                <span>Total Revenue</span>
                <span className="text-xs text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">View Breakout</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(misTotals ? misTotals.sales.revenue_from_goods : dashboardData.summary.total_revenue)}</div>
              <p className="text-xs text-gray-500 mt-1">{formatNumber(misTotals ? misTotals.orders : dashboardData.summary.transaction_count)} orders</p>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-all border-l-4 border-l-purple-500" 
            onClick={() => setCalculationModal({ open: true, type: 'Tax' })}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex justify-between">
                <span>Total Tax Liability</span>
                <span className="text-xs text-purple-500 bg-purple-50 px-2 py-0.5 rounded-full">View Breakout</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(misTotals ? misTotals.sales.tax : dashboardData.summary.total_tax)}</div>
              <p className="text-xs text-gray-500 mt-1">
                Tax collected from sales
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-lg transition-all border-l-4 border-l-green-500"
            onClick={() => setCalculationModal({ open: true, type: 'Units' })}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex justify-between">
                <span>Total Units</span>
                <span className="text-xs text-green-500 bg-green-50 px-2 py-0.5 rounded-full">View Breakout</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatNumber(misTotals ? misTotals.units.net : dashboardData.summary.total_units)}</div>
              <p className="text-xs text-gray-500 mt-1">
                Returns: {formatNumber(misTotals ? misTotals.units.returns : 0)} units
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-lg transition-all border-l-4 border-l-amber-500"
            onClick={() => setCalculationModal({ open: true, type: 'AOV' })}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex justify-between">
                <span>Avg Order Value</span>
                <span className="text-xs text-amber-500 bg-amber-50 px-2 py-0.5 rounded-full">View Breakout</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(
                  misTotals && misTotals.orders > 0
                    ? misTotals.sales.gross_inc_gst / misTotals.orders
                    : (dashboardData.summary.transaction_count > 0 ? dashboardData.summary.total_revenue / dashboardData.summary.transaction_count : 0)
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">Per order (Inc GST)</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs for Different Analyses */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="mis">Revenue MIS</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="geography">Geography</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
        </TabsList>

        {/* REVENUE MIS TAB */}
        <TabsContent value="mis" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle>Revenue MIS - {dashboardData.agentName || 'Agent'}</CardTitle>
                <CardDescription>Monthly Revenue and Units Summary</CardDescription>
              </div>
              <Button onClick={exportToExcel} variant="outline" size="sm">
                Download Report
              </Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-100 border-b">
                      <th className="p-3 text-left font-bold border-r min-w-[250px]">Particulars</th>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <th key={i} className="p-3 text-center font-bold border-r min-w-[120px]">
                          {m.month_label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bg-blue-50/50 border-b">
                      <td className="p-3 font-bold border-r">{dashboardData.agentName || 'Agent'}</td>
                      {dashboardData.revenueMIS.map((m, i) => <td key={i} className="p-3 border-r"></td>)}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-6 border-r">No of Orders</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-center border-r">{formatNumber(m.particulars.orders)}</td>
                      ))}
                    </tr>
                    <tr className="bg-gray-50 border-b">
                      <td className="p-3 font-semibold border-r">No. of Units</td>
                      {dashboardData.revenueMIS.map((m, i) => <td key={i} className="p-3 border-r"></td>)}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r">Gross</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-center border-r">{formatNumber(m.particulars.units.gross)}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r text-red-600">Returns</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-center border-r text-red-600">{formatNumber(m.particulars.units.returns)}</td>
                      ))}
                    </tr>
                    <tr className="bg-blue-50 border-b">
                      <td className="p-3 pl-8 font-bold border-r">No. of Units (Net of Sales Return)</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-center font-bold border-r">{formatNumber(m.particulars.units.net)}</td>
                      ))}
                    </tr>
                    <tr className="bg-gray-50 border-b">
                      <td className="p-3 font-semibold border-r">Sales</td>
                      {dashboardData.revenueMIS.map((m, i) => <td key={i} className="p-3 border-r"></td>)}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r">Gross Sales (Including GST)</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-right border-r font-medium">{formatNumber(m.particulars.sales.gross_inc_gst)}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r">Tax</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-right border-r text-gray-600">{formatNumber(m.particulars.sales.tax)}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r font-semibold">Net Sales</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-right border-r font-semibold">{formatNumber(m.particulars.sales.net_sales)}</td>
                      ))}
                    </tr>
                    <tr className="border-b">
                      <td className="p-3 pl-8 border-r text-red-600">Returns</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-right border-r text-red-600">{formatNumber(m.particulars.sales.returns)}</td>
                      ))}
                    </tr>
                    <tr className="bg-green-50 border-b">
                      <td className="p-3 pl-8 font-bold text-green-800 border-r">Revenue from Sales of Goods</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-right border-r font-bold text-green-800">{formatNumber(m.particulars.sales.revenue_from_goods)}</td>
                      ))}
                    </tr>
                    <tr className="bg-gray-100/50 border-b">
                      <td className="p-3 font-bold border-r">Average Order Value (Including GST)</td>
                      {dashboardData.revenueMIS.map((m, i) => (
                        <td key={i} className="p-3 text-center border-r font-bold">{formatNumber(m.particulars.aov)}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-4">
          {/* Monthly Trend */}
          <Card>
            <CardHeader>
              <CardTitle>Revenue & Tax Trend</CardTitle>
              <CardDescription>Monthly performance over time</CardDescription>
            </CardHeader>
            <CardContent>
              {dashboardData.monthlyTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={dashboardData.monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis yAxisId="left" />
                    <YAxis yAxisId="right" orientation="right" />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="revenue"
                      stroke="#0088FE"
                      name="Revenue"
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="tax"
                      stroke="#00C49F"
                      name="Tax"
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-gray-500 text-center py-8">No trend data available</p>
              )}
            </CardContent>
          </Card>

          {/* Payment Methods */}
          <Card>
            <CardHeader>
              <CardTitle>Payment Method Distribution</CardTitle>
              <CardDescription>Revenue by payment method</CardDescription>
            </CardHeader>
            <CardContent>
              {dashboardData.paymentMethods.length > 0 ? (
                <div className="space-y-4">
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={dashboardData.paymentMethods}
                        dataKey="revenue"
                        nameKey="payment_method"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label
                      >
                        {dashboardData.paymentMethods.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatCurrency(value)} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    {dashboardData.paymentMethods.map((method, idx) => (
                      <div
                        key={idx}
                        className="p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                        onClick={() => openDetailsModal(`Payment Method: ${method.payment_method}`)}
                      >
                        <div className="font-medium">{method.payment_method || 'N/A'}</div>
                        <div className="text-sm text-gray-600">{formatCurrency(method.revenue)}</div>
                        <div className="text-xs text-gray-500">{formatNumber(method.count)} transactions</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No payment data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* PRODUCTS TAB */}
        <TabsContent value="products" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Top 10 Products by Revenue</CardTitle>
              <CardDescription>Best performing SKUs</CardDescription>
            </CardHeader>
            <CardContent>
              {dashboardData.topProducts.length > 0 ? (
                <div className="space-y-4">
                  <ResponsiveContainer width="100%" height={400}>
                    <BarChart
                      data={dashboardData.topProducts}
                      layout="vertical"
                      margin={{ top: 5, right: 30, left: 200 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis type="category" dataKey="sku" width={190} />
                      <Tooltip formatter={(value) => formatCurrency(value)} />
                      <Bar dataKey="revenue" fill="#0088FE" name="Revenue" />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {dashboardData.topProducts.map((product, idx) => (
                      <div
                        key={idx}
                        className="p-4 border rounded-lg cursor-pointer hover:bg-gray-50 hover:shadow-md"
                        onClick={() => openDetailsModal(`SKU: ${product.sku}`, { sku: product.sku })}
                      >
                        <div className="font-medium text-sm">
                          {product.product_name || product.sku}
                        </div>
                        <div className="text-xs text-gray-600 my-1">SKU: {product.sku}</div>
                        <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                          <div>
                            <div className="text-gray-500">Revenue</div>
                            <div className="font-bold">{formatCurrency(product.revenue)}</div>
                          </div>
                          <div>
                            <div className="text-gray-500">Units</div>
                            <div className="font-bold">{formatNumber(product.units_sold)}</div>
                          </div>
                          <div>
                            <div className="text-gray-500">Avg Price</div>
                            <div className="font-bold">{formatCurrency(product.avg_price)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No product data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* GEOGRAPHY TAB */}
        <TabsContent value="geography" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>State-wise Sales Distribution</CardTitle>
              <CardDescription>Revenue by shipping state</CardDescription>
            </CardHeader>
            <CardContent>
              {dashboardData.stateWiseSales.length > 0 ? (
                <div className="space-y-4">
                  <ResponsiveContainer width="100%" height={400}>
                    <BarChart data={dashboardData.stateWiseSales} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis
                        type="category"
                        dataKey="state"
                        width={100}
                        tick={{ fontSize: 12 }}
                      />
                      <Tooltip formatter={(value) => formatCurrency(value)} />
                      <Bar dataKey="revenue" fill="#82CA9D" name="Revenue" />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                    {dashboardData.stateWiseSales.map((state, idx) => (
                      <div
                        key={idx}
                        className="p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                        onClick={() => openDetailsModal(`State: ${state.state}`, { state: state.state })}
                      >
                        <div className="font-medium text-sm">{state.state}</div>
                        <div className="text-xs text-gray-600 mt-1">
                          Revenue: {formatCurrency(state.revenue)}
                        </div>
                        <div className="text-xs text-gray-600">
                          Tax: {formatCurrency(state.tax)}
                        </div>
                        <div className="text-xs text-gray-600">
                          {formatNumber(state.transactions)} transactions
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No geographical data available</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* COMPLIANCE TAB */}
        <TabsContent value="compliance" className="space-y-4">
          {dashboardData.gstCompliance && (
            <Card>
              <CardHeader>
                <CardTitle>GST Compliance Status</CardTitle>
                <CardDescription>IRN filing status distribution</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={dashboardData.gstCompliance.status_breakdown}
                        dataKey="count"
                        nameKey="status"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label
                      >
                        {dashboardData.gstCompliance.status_breakdown.map(
                          (entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          )
                        )}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {dashboardData.gstCompliance.status_breakdown.map((status, idx) => (
                      <div key={idx} className="p-4 border rounded-lg bg-gray-50">
                        <div className="font-medium">{status.status}</div>
                        <div className="text-sm text-gray-600 mt-1">
                          {formatNumber(status.count)} records ({status.percentage}%)
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {dashboardData.taxAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle>Tax Breakdown</CardTitle>
                <CardDescription>Detailed tax liability analysis</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Item CGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.item_cgst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Item SGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.item_sgst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Item IGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.item_igst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Shipping CGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.shipping_cgst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Shipping SGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.shipping_sgst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg">
                    <div className="text-sm text-gray-600">Shipping IGST</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.shipping_igst)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg col-span-1 md:col-span-2 lg:col-span-3">
                    <div className="text-sm text-gray-600">Total TCS</div>
                    <div className="text-xl font-bold">
                      {formatCurrency(dashboardData.taxAnalysis.total_tcs)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ANALYSIS TAB */}
        <TabsContent value="analysis" className="space-y-4">
          {/* Refund Analysis */}
          {dashboardData.refundAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle>Refund & Return Analysis</CardTitle>
                <CardDescription>Impact of refunds on revenue and tax</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div className="border-l-4 border-blue-500 pl-4">
                      <div className="text-sm text-gray-600">Shipments</div>
                      <div className="text-2xl font-bold">
                        {formatNumber(dashboardData.refundAnalysis.shipments.count)}
                      </div>
                      <div className="text-sm text-gray-600 mt-2">
                        Units: {formatNumber(dashboardData.refundAnalysis.shipments.units)}
                      </div>
                      <div className="text-sm text-gray-600">
                        Revenue: {formatCurrency(dashboardData.refundAnalysis.shipments.revenue)}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-4" onClick={() => openDetailsModal('Refunds', { transaction_type: 'Refund' })}>
                    <div className="border-l-4 border-red-500 pl-4 cursor-pointer hover:bg-gray-50 p-4">
                      <div className="text-sm text-gray-600">Refunds</div>
                      <div className="text-2xl font-bold">
                        {formatNumber(dashboardData.refundAnalysis.refunds.count)}
                      </div>
                      <div className="text-sm text-gray-600 mt-2">
                        Units: {formatNumber(dashboardData.refundAnalysis.refunds.units)}
                      </div>
                      <div className="text-sm text-gray-600">
                        Amount: {formatCurrency(Math.abs(dashboardData.refundAnalysis.refunds.amount))}
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Discount Analysis */}
          {dashboardData.discountAnalysis && (
            <Card>
              <CardHeader>
                <CardTitle>Discount Analysis</CardTitle>
                <CardDescription>Impact of promotions on revenue</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer">
                    <div className="text-sm text-gray-600">Item Discount</div>
                    <div className="text-2xl font-bold">
                      {formatCurrency(dashboardData.discountAnalysis.item_discount)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer">
                    <div className="text-sm text-gray-600">Shipping Discount</div>
                    <div className="text-2xl font-bold">
                      {formatCurrency(dashboardData.discountAnalysis.shipping_discount)}
                    </div>
                  </div>
                  <div className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer">
                    <div className="text-sm text-gray-600">Total Discount</div>
                    <div className="text-2xl font-bold">
                      {formatCurrency(dashboardData.discountAnalysis.total_discount)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {dashboardData.discountAnalysis.discount_as_percent_of_revenue}% of revenue
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Transaction Details Modal */}
      <Dialog open={detailsModal.open} onOpenChange={(open) => !open && setDetailsModal({ ...detailsModal, open: false })}>
        <DialogContent className="max-w-5xl max-h-screen overflow-auto">
          <DialogHeader>
            <DialogTitle>{detailsModal.title} - Detailed View</DialogTitle>
            <DialogDescription>
              Showing {detailsModal.data.length} records
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100 sticky top-0">
                <tr>
                  <th className="p-2 text-left">Invoice</th>
                  <th className="p-2 text-left">Order ID</th>
                  <th className="p-2 text-left">Product</th>
                  <th className="p-2 text-right">Qty</th>
                  <th className="p-2 text-right">Revenue</th>
                  <th className="p-2 text-right">Tax</th>
                  <th className="p-2 text-left">Date</th>
                </tr>
              </thead>
              <tbody>
                {detailsModal.data.map((row, idx) => (
                  <tr key={idx} className="border-b hover:bg-gray-50">
                    <td className="p-2">{row.invoice_number || 'N/A'}</td>
                    <td className="p-2 text-xs">{row.order_id || 'N/A'}</td>
                    <td className="p-2 text-xs max-w-xs truncate">{row.sku || row.item_description || 'N/A'}</td>
                    <td className="p-2 text-right">{row.quantity}</td>
                    <td className="p-2 text-right text-blue-600 font-medium">
                      {formatCurrency(row.final_amount_receivable)}
                    </td>
                    <td className="p-2 text-right text-green-600 font-medium">
                      {formatCurrency(
                        (parseFloat(row.final_cgst_tax || 0) +
                          parseFloat(row.final_sgst_tax || 0) +
                          parseFloat(row.final_igst_tax || 0))
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {row.created_at ? format(new Date(row.created_at), 'dd MMM yyyy') : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
  {/* Calculation Breakout Modal */}
  <Dialog open={calculationModal.open} onOpenChange={(open) => !open && setCalculationModal({ ...calculationModal, open: false })}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{calculationModal.type} - Calculation Breakout</DialogTitle>
      </DialogHeader>
      <div className="p-5 bg-slate-50 rounded-lg border shadow-sm">
        {calculationModal.type === 'Revenue' && misTotals && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm text-slate-600">
              <span>Gross Sales (Including GST)</span>
              <span>+ {formatCurrency(misTotals.sales.gross_inc_gst)}</span>
            </div>
            <div className="flex justify-between text-sm text-red-600">
              <span>Tax</span>
              <span>- {formatCurrency(misTotals.sales.tax)}</span>
            </div>
            <hr className="my-2 border-slate-200" />
            <div className="flex justify-between font-semibold text-md text-slate-800">
              <span>Net Sales</span>
              <span>{formatCurrency(misTotals.sales.net_sales)}</span>
            </div>
            <div className="flex justify-between text-sm text-red-600">
              <span>Returns</span>
              <span>- {formatCurrency(misTotals.sales.returns)}</span>
            </div>
            <hr className="my-3 border-slate-200" />
            <div className="flex justify-between font-bold text-lg text-slate-900">
              <span>Revenue from Sales of Goods</span>
              <span>{formatCurrency(misTotals.sales.revenue_from_goods)}</span>
            </div>
          </div>
        )}

        {calculationModal.type === 'Tax' && misTotals && dashboardData?.summary && dashboardData?.taxAnalysis && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm text-slate-600">
              <span>CGST (Central Tax)</span>
              <span>+ {formatCurrency(dashboardData.summary.total_cgst)}</span>
            </div>
            <div className="flex justify-between text-sm text-slate-600">
              <span>SGST (State Tax)</span>
              <span>+ {formatCurrency(dashboardData.summary.total_sgst)}</span>
            </div>
            <div className="flex justify-between text-sm text-slate-600">
              <span>IGST (Integrated Tax)</span>
              <span>+ {formatCurrency(dashboardData.summary.total_igst)}</span>
            </div>
            <hr className="my-3 border-slate-200" />
            <div className="flex justify-between font-bold text-lg text-slate-900">
              <span>Total Tax Liability</span>
              <span>{formatCurrency(misTotals.sales.tax)}</span>
            </div>
            <div className="text-xs text-slate-500 mt-4 bg-white p-3 rounded border">
              <strong>Note:</strong> This includes item tax and shipping tax, but excludes TCS. Total TCS withheld is {formatCurrency(dashboardData.taxAnalysis.total_tcs || 0)}.
            </div>
          </div>
        )}

        {calculationModal.type === 'Units' && misTotals && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm text-slate-600">
              <span>Gross Units Sold</span>
              <span>+ {formatNumber(misTotals.units.gross)}</span>
            </div>
            <div className="flex justify-between text-sm text-red-600">
              <span>Units Returned</span>
              <span>- {formatNumber(misTotals.units.returns)}</span>
            </div>
            <hr className="my-3 border-slate-200" />
            <div className="flex justify-between font-bold text-lg text-slate-900">
              <span>No. of Units (Net of Sales Return)</span>
              <span>{formatNumber(misTotals.units.net)}</span>
            </div>
          </div>
        )}

        {calculationModal.type === 'AOV' && misTotals && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm text-slate-600">
              <span>Gross Sales (Including GST) (A)</span>
              <span>{formatCurrency(misTotals.sales.gross_inc_gst)}</span>
            </div>
            <div className="flex justify-between text-sm text-slate-600">
              <span>Total Orders (B)</span>
              <span>{formatNumber(misTotals.orders)}</span>
            </div>
            <hr className="my-3 border-slate-200" />
            <div className="flex justify-between font-bold text-lg text-slate-900">
              <span>Avg Order Value (A / B)</span>
              <span>
                {formatCurrency(
                  misTotals.orders > 0
                    ? misTotals.sales.gross_inc_gst / misTotals.orders
                    : 0
                )}
              </span>
            </div>
          </div>
        )}
      </div>
    </DialogContent>
  </Dialog>
    </div >
  );
};

export default CFODashboardAmazon;
