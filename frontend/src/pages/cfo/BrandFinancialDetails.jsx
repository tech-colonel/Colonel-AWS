import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/button';
import CFOAmazonDashboard from './AmazonCFODashboard';
import { Alert, AlertDescription } from '../../components/ui/alert';

const CFOBrandDashboard = () => {
  const { brandId, agentId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (agentId) {
      // Fetch agent details
      // For now, we'll assume agent exists
      setAgent({ id: agentId, name: 'Sales-Amazon' });
    }
    setLoading(false);
  }, [agentId]);

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Back to Dashboard', icon: ArrowLeft }
  ];

  if (!agentId) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6">
          <Alert variant="destructive">
            <AlertDescription>
              Please select an agent to view the CFO Dashboard
            </AlertDescription>
          </Alert>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-4 md:p-6">
        <div className="mb-6">
          <Button
            variant="ghost"
            onClick={() => navigate(-1)}
            className="mb-4"
          >
            ← Back
          </Button>
          <h1 className="text-3xl font-bold">CFO Dashboard</h1>
          <p className="text-gray-600 mt-2">Financial Analysis & Business Intelligence</p>
        </div>

        {agentId && (
          <CFOAmazonDashboard brandId={brandId} agentId={agentId} />
        )}
      </div>
    </DashboardLayout>
  );
};

export default CFOBrandDashboard;
