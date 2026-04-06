import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { BarChart3, Activity, CalendarDays } from 'lucide-react';
import CFODashboardAmazon from './AmazonCFODashboard';

const CFODashboardLauncher = ({ brandId, agentId, agent, allAgents, cfoConfig, setCfoConfig }) => {
  const navigate = useNavigate();

  const hasValidPeriod = !!(cfoConfig?.startMonth && cfoConfig?.startYear && cfoConfig?.endMonth && cfoConfig?.endYear);
  const [dashboardOpen, setDashboardOpen] = useState(hasValidPeriod);

  const uniqueYears = React.useMemo(() => {
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

  const handleGenerate = () => {
    if (!cfoConfig.startMonth || !cfoConfig.startYear || !cfoConfig.endMonth || !cfoConfig.endYear) {
      alert("Please select all period fields before continuing.");
      return;
    }
    setDashboardOpen(true);
  };

  const handleClose = () => {
    setDashboardOpen(false);
    setCfoConfig(prev => ({ ...prev, isOpen: false }));
  };

  const handleAgentSwitch = (e) => {
    const newAgentId = e.target.value;
    if (newAgentId === agentId) return;
    
    // Push the new agent route but maintain the cfoConfig context via location.state
    navigate(`/brands/${brandId}/agents/${newAgentId}`, {
      state: {
        openCfo: true,
        startMonth: cfoConfig.startMonth,
        startYear: cfoConfig.startYear,
        endMonth: cfoConfig.endMonth,
        endYear: cfoConfig.endYear
      }
    });
  };

  // If the user modifies the dates while the dashboard is open, we can auto-update or wait for them to click "Update".
  // Keeping it as a manual "Update / Generate" button is safer for performance.
  const handleDateChange = (field, value) => {
    setCfoConfig(p => ({ ...p, [field]: value }));
    // Optional: if you want changes to auto-reset the dashboard until they click generate:
    // setDashboardOpen(false); 
  };

  return (
    <div className="bg-slate-50 min-h-screen -m-6 flex flex-col">
      {/* Unified Sticky Header Container */}
      <div className="sticky top-0 z-20 shrink-0 shadow-sm w-full">
        {/* Top Navigation & Agent Switcher */}
        <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
          <div className="flex flex-col">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
                <BarChart3 className="w-6 h-6 text-slate-700" />
                CFO Dashboard
              </h2>
              {allAgents && allAgents.length > 0 && (
                <select 
                  className="p-1.5 ml-2 border rounded-md text-sm bg-slate-50 font-medium cursor-pointer hover:bg-slate-100 transition-colors focus:ring-2 focus:ring-slate-400 outline-none"
                  value={agentId}
                  onChange={handleAgentSwitch}
                >
                  {allAgents.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={handleClose}>
              ← Exit Analytics
            </Button>
          </div>
        </div>

        {/* Embedded Settings Bar (Analysis Period) */}
        <div className="bg-white border-b px-8 py-5">
        <div className="flex items-end gap-6 max-w-[1600px] mx-auto">
          <div className="flex-1 grid grid-cols-4 gap-4">
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Start Month</label>
              <select
                className={`w-full p-2 border rounded-md text-sm transition-colors ${!cfoConfig.startMonth ? 'border-sky-400 ring-4 ring-sky-50' : 'border-slate-200'} focus:outline-none focus:border-slate-400`}
                value={cfoConfig.startMonth}
                onChange={(e) => handleDateChange('startMonth', e.target.value)}
              >
                <option value="">Select</option>
                {monthsList.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Start Year</label>
              <select
                className={`w-full p-2 border rounded-md text-sm transition-colors ${!cfoConfig.startYear ? 'border-sky-400 ring-4 ring-sky-50' : 'border-slate-200'} focus:outline-none focus:border-slate-400`}
                value={cfoConfig.startYear}
                onChange={(e) => handleDateChange('startYear', e.target.value)}
              >
                <option value="">Select</option>
                {uniqueYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">End Month</label>
              <select
                className={`w-full p-2 border rounded-md text-sm transition-colors ${!cfoConfig.endMonth ? 'border-sky-400 ring-4 ring-sky-50' : 'border-slate-200'} focus:outline-none focus:border-slate-400`}
                value={cfoConfig.endMonth}
                onChange={(e) => handleDateChange('endMonth', e.target.value)}
              >
                <option value="">Select</option>
                {monthsList.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">End Year</label>
              <select
                className={`w-full p-2 border rounded-md text-sm transition-colors ${!cfoConfig.endYear ? 'border-sky-400 ring-4 ring-sky-50' : 'border-slate-200'} focus:outline-none focus:border-slate-400`}
                value={cfoConfig.endYear}
                onChange={(e) => handleDateChange('endYear', e.target.value)}
              >
                <option value="">Select</option>
                {uniqueYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="shrink-0">
             <Button 
               onClick={handleGenerate}
               className="px-8 min-w-[140px]"
             >
               {dashboardOpen ? 'Update View' : 'Generate Dashboard'}
             </Button>
          </div>
        </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-6 relative overflow-y-auto">
        {!dashboardOpen ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-500">
            <div className="w-24 h-24 bg-white rounded-full flex items-center justify-center shadow-lg border border-slate-100 mb-6 relative">
              <div className="absolute inset-0 bg-sky-100 rounded-full animate-ping opacity-20"></div>
              <CalendarDays className="w-10 h-10 text-sky-500 relative z-10" />
            </div>
            <h3 className="text-3xl font-bold text-slate-900 tracking-tight">Select Analysis Period</h3>
            <p className="text-slate-500 mt-3 max-w-md mx-auto text-lg">
              Highlight the date range fields in the top navigation bar to populate this financial dashboard with agent data.
            </p>
          </div>
        ) : (
          <div className="max-w-[1600px] mx-auto animate-in slide-in-from-bottom-4 fade-in duration-500">
            {/* The individual agent-specific CFO dashboard gets rendered here when period is active */}
            <CFODashboardAmazon 
              brandId={brandId} 
              agentId={agentId} 
              initialStartMonth={cfoConfig.startMonth}
              initialStartYear={cfoConfig.startYear}
              initialEndMonth={cfoConfig.endMonth}
              initialEndYear={cfoConfig.endYear}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default CFODashboardLauncher;
