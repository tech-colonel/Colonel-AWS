import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { LayoutDashboard, Bot } from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ADMIN_SIDEBAR, sidebarFor } from '../../lib/adminNav';
import TallyDashboard from './TallyDashboard';

/* Admin: every Tally company that has synced. */
export function AdminTallyDashboardPage() {
  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <TallyDashboard base="/api/tally" />
    </DashboardLayout>
  );
}

/* Brand side: the Tally companies linked to this brand. */
export function BrandTallyDashboardPage() {
  const { brandId } = useParams();
  // Keep the sidebar's brand-scoped links (incl. Tally Dashboard) pointing at this brand.
  useEffect(() => { try { localStorage.setItem('lastBrandId', brandId); } catch { /* private mode */ } }, [brandId]);
  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);
  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <TallyDashboard base={`/api/brands/${brandId}/tally`} />
    </DashboardLayout>
  );
}
