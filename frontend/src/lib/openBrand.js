import api from './api';

// Opening a brand lands on its Tally dashboard when a Tally company is linked to it
// (matched by name, or linked by an admin); otherwise on the usual brand dashboard.
export async function openBrand(navigate, brandId) {
  let dest = 'dashboard';
  try {
    const { data } = await api.get(`/api/brands/${brandId}/tally/overview`);
    if (data && Array.isArray(data.companies) && data.companies.length) dest = 'tally-dashboard';
  } catch (_) { /* no Tally access or backend without Tally → normal dashboard */ }
  navigate(`/brands/${brandId}/${dest}`);
}
