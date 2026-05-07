import React, { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Loader2, ChevronDown, Check, Search, X } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '../../lib/api';
import { toast } from 'sonner';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#8dd1e1', '#a4de6c', '#d0ed57'];

// Custom dropdown for SKU selection with search
const MultiSelectDropdown = ({ options, selected, onChange, label }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const toggleOption = (opt) => {
    if (selected.includes(opt)) {
      onChange(selected.filter(i => i !== opt));
    } else {
      onChange([...selected, opt]);
    }
  };

  const clearAll = () => onChange([]);

  const filteredOptions = options.filter(opt =>
    opt.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="relative">
      <button 
        onClick={() => { setIsOpen(!isOpen); if (!isOpen) { setSearchOpen(false); setSearchTerm(''); } }}
        className="flex items-center justify-between w-64 border border-slate-300 bg-white px-3 py-2 rounded text-sm shadow-sm"
      >
        <span className="truncate">{selected.length} {label} Selected</span>
        <ChevronDown className="h-4 w-4 ml-2 opacity-50" />
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-72 bg-white border border-slate-200 rounded shadow-lg max-h-72 overflow-auto">
          <div className="sticky top-0 bg-slate-50 border-b border-slate-200 p-2">
            <div className="flex justify-between items-center">
              {searchOpen ? (
                <div className="flex items-center gap-1 flex-1 bg-white border border-slate-300 rounded px-2 py-1">
                  <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search SKU..."
                    className="text-xs w-full outline-none bg-transparent"
                    autoFocus
                  />
                  <button onClick={() => { setSearchOpen(false); setSearchTerm(''); }}>
                    <X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" />
                  </button>
                </div>
              ) : (
                <>
                  <button 
                    onClick={() => setSearchOpen(true)} 
                    className="flex items-center gap-1 text-xs text-indigo-600 font-medium hover:underline"
                  >
                    <Search className="h-3.5 w-3.5" /> Search
                  </button>
                  <button onClick={clearAll} className="text-xs text-slate-600 font-medium hover:underline">Clear All</button>
                </>
              )}
            </div>
          </div>
          <div className="p-1">
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-400 text-center">No SKUs found</div>
            ) : (
              filteredOptions.map(opt => (
                <label key={opt} className="flex items-center px-2 py-1.5 hover:bg-slate-100 cursor-pointer rounded text-sm">
                  <input 
                    type="checkbox" 
                    checked={selected.includes(opt)}
                    onChange={() => toggleOption(opt)}
                    className="mr-2 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const TotalSalesAnalyzerModal = ({ isOpen, onClose, brandId, agentId }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [activeTab, setActiveTab] = useState('sku'); // 'sku', 'location', 'buyer'

  // SKU State
  const [selectedSkus, setSelectedSkus] = useState([]);
  
  // Location State
  const [selectedState, setSelectedState] = useState(null); // for drilling down into state particulars
  
  // Buyer State
  const [selectedBuyer, setSelectedBuyer] = useState(null);

  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen, year]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const response = await api.post(`/api/brands/${brandId}/agents/${agentId}/total-sales-analyzer/dashboard`, {
        year
      });
      setData(response.data);
      
      // Initialize top 10 SKUs
      if (response.data?.skuMonthData) {
        const skuTotals = {};
        Object.keys(response.data.skuMonthData).forEach(sku => {
          skuTotals[sku] = 0;
          Object.keys(response.data.skuMonthData[sku]).forEach(m => {
            skuTotals[sku] += response.data.skuMonthData[sku][m].value;
          });
        });
        const top10 = Object.keys(skuTotals).sort((a,b) => skuTotals[b] - skuTotals[a]).slice(0, 10);
        setSelectedSkus(top10);
      }
      setSelectedState(null);
      setSelectedBuyer(null);
    } catch (error) {
      toast.error('Failed to load dashboard data');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(val);

  // --- SKU Processing ---
  const skuMonthChartData = useMemo(() => {
    if (!data?.skuMonthData) return [];
    const months = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '1', '2', '3'];
    const monthNames = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
    return months.map((m, i) => {
      const obj = { month: monthNames[i] };
      selectedSkus.forEach(sku => {
        obj[sku] = data.skuMonthData[sku][m] ? data.skuMonthData[sku][m].value : 0;
      });
      return obj;
    });
  }, [data, selectedSkus]);

  // --- Location Processing ---
  const locationChartData = useMemo(() => {
    if (!data?.locationData) return { pieData: [], othersList: [] };
    
    let totalSales = 0;
    const stateTotals = [];
    
    Object.keys(data.locationData).forEach(state => {
      let st = 0;
      Object.keys(data.locationData[state]).forEach(city => {
        st += data.locationData[state][city].value;
      });
      if (st > 0) {
        totalSales += st;
        stateTotals.push({ name: state === 'null' ? 'Unknown' : state, value: st, originalName: state });
      }
    });

    stateTotals.sort((a, b) => b.value - a.value);

    const pieData = [];
    const othersList = [];
    let othersValue = 0;

    stateTotals.forEach(st => {
      if (st.value / totalSales < 0.03) {
        othersList.push(st);
        othersValue += st.value;
      } else {
        const pct = ((st.value / totalSales) * 100).toFixed(1);
        pieData.push({ ...st, displayLabel: st.name + ' (' + pct + '%)' });
      }
    });

    if (othersValue > 0) {
      const pct = ((othersValue / totalSales) * 100).toFixed(1);
      pieData.push({ name: 'Others (<3%)', value: othersValue, isOthers: true, componentStates: othersList, displayLabel: 'Others (' + pct + '%)' });
    }

    return { pieData, othersList, totalSales };
  }, [data]);

  const stateParticularsData = useMemo(() => {
    if (!selectedState || !data?.locationStateBuyers) return [];
    // if 'Others (<3%)' is clicked, we might not show a single state, but let's handle normal states first
    const originalStateName = selectedState.originalName;
    const buyers = data.locationStateBuyers[originalStateName] || {};
    return Object.keys(buyers)
      .map(b => ({ 
        name: b, 
        displayName: b.length > 25 ? b.substring(0, 22) + '...' : b,
        value: buyers[b] 
      }))
      .sort((a,b) => b.value - a.value)
      .slice(0, 10); // top 10 buyers for this state
  }, [selectedState, data]);

  // --- Buyer Processing ---
  const buyerChartData = useMemo(() => {
    if (!data?.buyerData) return [];
    return Object.keys(data.buyerData)
      .map(buyer => ({ 
        name: buyer, 
        displayName: buyer.length > 25 ? buyer.substring(0, 22) + '...' : buyer,
        value: data.buyerData[buyer].value 
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [data]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const dataEntry = payload[0].payload;
      
      return (
        <div className="bg-white p-3 border border-slate-200 rounded shadow-lg text-sm max-w-[300px]">
          <p className="font-bold text-slate-800 mb-2 border-b pb-1">{dataEntry.name || label}</p>
          
          {dataEntry.isOthers ? (
            <div>
              <p className="font-semibold text-indigo-600 mb-1">Total: {formatCurrency(dataEntry.value)}</p>
              <p className="text-xs text-slate-500 mb-1">Composed of:</p>
              <div className="max-h-32 overflow-y-auto">
                {dataEntry.componentStates.map(st => (
                  <div key={st.name} className="flex justify-between text-xs py-0.5">
                    <span className="truncate pr-2">{st.name}</span>
                    <span className="font-medium">{formatCurrency(st.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            payload.map((entry, index) => (
              <div key={index} className="flex justify-between gap-4 py-0.5">
                <span className="truncate max-w-[150px]" style={{ color: entry.color }}>{entry.name}:</span>
                <span className="font-medium">{formatCurrency(entry.value)}</span>
              </div>
            ))
          )}
        </div>
      );
    }
    return null;
  };

  const RADIAN = Math.PI / 180;
  const renderPieLabel = (props) => {
    const { cx, cy, midAngle, outerRadius, index } = props;
    const entry = locationChartData.pieData[index];
    if (!entry) return null;
    const pctValue = locationChartData.totalSales > 0
      ? ((entry.value / locationChartData.totalSales) * 100).toFixed(1)
      : '0.0';
    const radius = outerRadius + 30;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} fill="#334155" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={11} fontWeight={600}>
        {entry.name + ' (' + pctValue + '%)'}
      </text>
    );
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[1400px] w-full max-h-[90vh] overflow-y-auto bg-slate-50">
        <DialogHeader className="bg-white p-6 border-b border-slate-200 -mt-6 -mx-6 mb-6 sticky top-0 z-10">
          <div className="flex justify-between items-center pr-8">
            <div>
              <DialogTitle className="text-2xl font-bold text-slate-900">Total Sales Analyzer</DialogTitle>
              <p className="text-slate-500 text-sm mt-1">Deep analysis of SKUs, Locations, and Buyers</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600 font-semibold">Financial Year:</span>
                <select 
                  value={year} 
                  onChange={(e) => setYear(e.target.value)}
                  className="border border-slate-300 rounded-md p-1.5 text-sm bg-white font-medium shadow-sm focus:ring-2 focus:ring-indigo-500"
                >
                  {[...Array(5)].map((_, i) => {
                    const y = new Date().getFullYear() - i;
                    return <option key={y} value={y}>{y}-{String(y+1).slice(2)}</option>;
                  })}
                </select>
              </div>
              <button 
                onClick={onClose}
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-md text-sm transition-colors"
              >
                Close
              </button>
            </div>
          </div>
          
          {/* Tabs */}
          {!loading && data && (
            <div className="flex gap-4 mt-6 border-b border-slate-200">
              {[
                { id: 'sku', label: 'SKU Performance' },
                { id: 'location', label: 'Location Analysis' },
                { id: 'buyer', label: 'Top Buyers' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setSelectedState(null); setSelectedBuyer(null); }}
                  className={`px-4 py-2 text-sm font-semibold transition-colors border-b-2 -mb-[1px] ${
                    activeTab === tab.id 
                      ? 'border-indigo-600 text-indigo-600' 
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-32">
            <Loader2 className="h-12 w-12 animate-spin text-indigo-500 mb-4" />
            <p className="text-slate-500 font-medium">Crunching Sales Data...</p>
          </div>
        ) : data ? (
          <div className="px-2 pb-8 space-y-6">

            {/* TAB: SKU PERFORMANCE */}
            {activeTab === 'sku' && (
              <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-800">SKU Performance (Month-wise)</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Based on <span className="font-semibold text-indigo-500">Value</span> column</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-slate-600">Select SKUs to Analyze:</span>
                    <MultiSelectDropdown 
                      options={data.allSkus || []}
                      selected={selectedSkus}
                      onChange={setSelectedSkus}
                      label="SKUs"
                    />
                  </div>
                  </div>
                
                {selectedSkus.length === 0 ? (
                  <div className="h-[450px] flex items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-lg">
                    Please select at least one SKU to view the chart.
                  </div>
                ) : (
                  <div className="h-[500px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={skuMonthChartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontWeight: 500}} />
                        <YAxis tickFormatter={(val) => `₹${(val/100000).toFixed(1)}L`} axisLine={false} tickLine={false} tick={{fill: '#64748b'}} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ paddingTop: '20px' }} />
                        {selectedSkus.map((sku, index) => (
                          <Line 
                            key={sku} 
                            type="monotone" 
                            dataKey={sku} 
                            stroke={COLORS[index % COLORS.length]} 
                            strokeWidth={3}
                            activeDot={{ r: 6 }}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* TAB: LOCATION ANALYSIS */}
            {activeTab === 'location' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Sales Distribution by Location</h3>
                  <p className="text-xs text-slate-400 mb-1">Based on <span className="font-semibold text-indigo-500">Sales Value</span> column</p>
                  <p className="text-sm text-slate-500 mb-6">Click on a state slice to view its top buyers. Regions &lt;3% are grouped into "Others".</p>
                  <div className="h-[450px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={locationChartData.pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={80}
                          outerRadius={140}
                          paddingAngle={2}
                          dataKey="value"
                          label={renderPieLabel}
                          labelLine={{ stroke: '#94a3b8', strokeWidth: 1 }}
                          onClick={(data) => {
                            if (!data.isOthers) {
                              setSelectedState(data);
                            } else {
                              setSelectedState(null);
                              toast.info('Cannot drill down into the mixed "Others" category. Hover to see details.');
                            }
                          }}
                          className="cursor-pointer"
                        >
                          {locationChartData.pieData.map((entry, index) => (
                            <Cell 
                              key={`cell-${index}`} 
                              fill={entry.isOthers ? '#cbd5e1' : COLORS[index % COLORS.length]} 
                              stroke={selectedState?.name === entry.name ? '#0f172a' : 'none'}
                              strokeWidth={selectedState?.name === entry.name ? 3 : 0}
                            />
                          ))}
                        </Pie>
                        <Tooltip content={<CustomTooltip />} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm">
                  {selectedState ? (
                    <>
                      <h3 className="text-lg font-bold text-slate-800 mb-2">Top Buyers in <span className="text-indigo-600">{selectedState.name}</span></h3>
                      <p className="text-sm text-slate-500 mb-6">Total State Sales: {formatCurrency(selectedState.value)}</p>
                      <div className="h-[450px]">
                        {stateParticularsData.length > 0 ? (
                           <ResponsiveContainer width="100%" height="100%">
                           <BarChart
                             layout="vertical"
                             data={stateParticularsData}
                             margin={{ top: 5, right: 30, left: 0, bottom: 5 }}
                           >
                             <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
                             <XAxis type="number" tickFormatter={(val) => `₹${(val/1000).toFixed(0)}k`} tick={{fill: '#64748b'}} />
                             <YAxis 
                               type="category" 
                               dataKey="displayName" 
                               width={175} 
                               tick={{ fontSize: 11, fill: '#334155' }} 
                               interval={0} 
                             />
                             <Tooltip content={<CustomTooltip />} />
                             <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} barSize={16} />
                           </BarChart>
                         </ResponsiveContainer>
                        ) : (
                          <div className="flex items-center justify-center h-full text-slate-400">No buyer data available for this state.</div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400 border-2 border-dashed border-slate-200 rounded-lg p-6 text-center">
                      <BarChart className="w-16 h-16 mb-4 text-slate-300" />
                      <p className="text-lg font-medium text-slate-600 mb-2">Select a State</p>
                      <p className="text-sm">Click on any specific state slice in the pie chart to drill down into its top buyers.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB: TOP BUYERS */}
            {activeTab === 'buyer' && (
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm lg:col-span-3">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Overall Top Buyers</h3>
                  <p className="text-xs text-slate-400 mb-1">Ranked by <span className="font-semibold text-indigo-500">Sales Value</span> column</p>
                  <p className="text-sm text-slate-500 mb-6">Click a buyer's bar to analyze their specific purchase breakdown.</p>
                  <div className="h-[600px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        layout="vertical"
                        data={buyerChartData}
                        margin={{ top: 5, right: 30, left: 0, bottom: 5 }}
                        onClick={(data) => {
                          if (data && data.activeLabel) {
                            setSelectedBuyer(data.activeLabel);
                          }
                        }}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
                        <XAxis type="number" tickFormatter={(val) => `₹${(val/100000).toFixed(1)}L`} tick={{fill: '#64748b'}} />
                        <YAxis type="category" dataKey="displayName" width={170} tick={{ fontSize: 12, fill: '#334155', fontWeight: 500 }} interval={0} />
                        <Tooltip content={<CustomTooltip />} cursor={{fill: '#f1f5f9'}} />
                        <Bar 
                          dataKey="value" 
                          fill="#8b5cf6" 
                          radius={[0, 4, 4, 0]} 
                          className="cursor-pointer"
                        >
                          {buyerChartData.map((entry, index) => (
                            <Cell 
                              key={`cell-${index}`} 
                              fill={selectedBuyer === entry.name ? '#6d28d9' : '#8b5cf6'} 
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="lg:col-span-2">
                  {selectedBuyer ? (
                    <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm h-full">
                      <h3 className="text-lg font-bold text-slate-800 mb-1 border-b pb-4">
                        Buyer Deep Dive
                        <span className="block text-indigo-600 text-xl mt-1">{selectedBuyer}</span>
                      </h3>
                      
                      <div className="mt-6 space-y-6">
                        <div>
                          <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Top SKUs Purchased</p>
                          <div className="space-y-2">
                            {Object.entries(data.buyerDetails[selectedBuyer]?.skus || {})
                              .sort((a,b) => b[1] - a[1])
                              .slice(0, 5)
                              .map(([sku, val]) => (
                                <div key={sku} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-100">
                                  <span className="text-sm font-medium text-slate-700 truncate pr-2">{sku}</span>
                                  <span className="text-sm font-bold text-slate-900">{formatCurrency(val)}</span>
                                </div>
                              ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Top Delivery States</p>
                          <div className="space-y-2">
                            {Object.entries(data.buyerDetails[selectedBuyer]?.states || {})
                              .sort((a,b) => b[1] - a[1])
                              .slice(0, 5)
                              .map(([st, val]) => (
                                <div key={st} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-100">
                                  <span className="text-sm font-medium text-slate-700 truncate pr-2">{st}</span>
                                  <span className="text-sm font-bold text-slate-900">{formatCurrency(val)}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                        
                        <div className="bg-indigo-50 p-4 rounded-lg mt-8">
                           <p className="text-sm text-indigo-800 mb-1">Total Lifetime Value (Selected Year)</p>
                           <p className="text-2xl font-bold text-indigo-900">
                             {formatCurrency(data.buyerData[selectedBuyer]?.value || 0)}
                           </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-white border border-slate-200 p-6 rounded-xl shadow-sm h-full flex flex-col items-center justify-center text-slate-400 text-center">
                      <p className="text-lg font-medium text-slate-600 mb-2">Buyer Deep Dive</p>
                      <p className="text-sm max-w-xs">Click on any buyer in the chart to see their top SKUs and Location distribution.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        ) : (
          <div className="py-20 text-center text-slate-500">
            No data available.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default TotalSalesAnalyzerModal;
