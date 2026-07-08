import React, { useState, useEffect, useMemo } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Building2, Plus, Search, ChevronRight, ChevronLeft, Users, Sparkles, Layers } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const initials = (n = '') => n.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'B';
// Dummy clients that OWN the real brands (grouped round-robin). Real client tables can come later.
const CLIENT_DEFS = [
  { name: 'Ajmera Ventures', industry: 'D2C Holding', contact: 'partner@ajmeraventures.com', color: '#6D5AE6' },
  { name: 'Spatial AI', industry: 'Electronics & Accessories', contact: 'ops@spatial.ai', color: '#0EA5E9' },
  { name: 'Drips Foods Pvt Ltd', industry: 'Food & Beverage', contact: 'finance@dripsfoods.in', color: '#EC4899' },
  { name: 'Nest Group', industry: 'Home & Living', contact: 'accounts@nestgroup.co', color: '#F59E0B' },
  { name: 'Urban Collective', industry: 'Lifestyle & Apparel', contact: 'ca@urbancollective.in', color: '#059669' },
];

const BrandsPage = () => {
  const navigate = useNavigate();
  const [brands, setBrands] = useState([]);
  const [tab, setTab] = useState('clients');
  const [activeClient, setActiveClient] = useState(null);
  const [query, setQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', image_url: '' });

  useEffect(() => { fetchBrands(); }, []);
  const fetchBrands = async () => { try { const r = await api.get('/api/brands'); setBrands(Array.isArray(r.data) ? r.data : []); } catch { toast.error('Failed to load brands'); } };

  const clients = useMemo(() => {
    const defs = CLIENT_DEFS.map((d) => ({ ...d, brands: [] }));
    brands.forEach((b, i) => defs[i % defs.length].brands.push(b));
    return defs.filter((c) => c.brands.length);
  }, [brands]);

  const shownBrands = useMemo(() => {
    let list = activeClient ? (clients.find((c) => c.name === activeClient)?.brands || []) : brands;
    const q = query.trim().toLowerCase();
    return q ? list.filter((b) => (b.name || '').toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q)) : list;
  }, [brands, clients, activeClient, query]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try { await api.post('/api/brands', formData); toast.success('Brand created'); setShowModal(false); setFormData({ name: '', description: '', image_url: '' }); fetchBrands(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed to create brand'); }
  };

  const tabBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 9999, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: active ? V : '#fff', color: active ? '#fff' : '#0F172A', border: `1px solid ${active ? V : '#E6EAF3'}`, boxShadow: '0 1px 3px rgba(10,15,46,.05)' });

  const openClient = (c) => { setActiveClient(c.name); setTab('brands'); };

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%), radial-gradient(900px 440px at 100% -6%, #FBEAF5 0%, transparent 52%)' }} data-testid="brands-page">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>Brands &amp; Clients</h1>
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 4 }}>Manage the firm's clients and the brands they own.</p>
          </div>
          <Button onClick={() => setShowModal(true)} data-testid="create-brand-button" style={{ background: V }}><Plus className="mr-2 h-4 w-4" /> New brand</Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
          <button style={tabBtn(tab === 'clients')} onClick={() => { setTab('clients'); setActiveClient(null); }}><Users style={{ width: 15, height: 15 }} /> Clients</button>
          <button style={tabBtn(tab === 'brands')} onClick={() => setTab('brands')}><Building2 style={{ width: 15, height: 15 }} /> Brands</button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #E6EAF3', borderRadius: 9999, padding: '8px 14px', minWidth: 220 }}>
            <Search style={{ width: 15, height: 15, color: '#94A3B8' }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13 }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
          <div>
            {tab === 'clients' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                {clients.map((c) => (
                  <div key={c.name} className="glass-card" style={{ padding: '18px', cursor: 'pointer', transition: 'transform .14s, box-shadow .14s' }}
                    onClick={() => openClient(c)}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--card-shadow-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                      <span style={{ width: 46, height: 46, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 15, background: `linear-gradient(135deg, ${c.color}, ${c.color}CC)` }}>{initials(c.name)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                        <div style={{ fontSize: 12, color: '#94A3B8' }}>{c.industry}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12, minHeight: 22 }}>
                      {c.brands.slice(0, 4).map((b) => <span key={b.id} style={{ fontSize: 10.5, fontWeight: 700, color: V, background: V_WASH, padding: '2px 8px', borderRadius: 9999 }}>{b.name}</span>)}
                      {c.brands.length > 4 && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#64748B', background: '#F1F5F9', padding: '2px 8px', borderRadius: 9999 }}>+{c.brands.length - 4}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #EEF1F8', paddingTop: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#0F172A' }}>{c.brands.length} brand{c.brands.length !== 1 ? 's' : ''}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: V }}>View brands<ChevronRight style={{ width: 13, height: 13 }} /></span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {activeClient && (
                  <button onClick={() => setActiveClient(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: V, background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>
                    <ChevronLeft style={{ width: 14, height: 14 }} /> All clients · showing <strong style={{ marginLeft: 4 }}>{activeClient}</strong>
                  </button>
                )}
                {shownBrands.length === 0 ? (
                  <div className="glass-card" style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><Building2 style={{ width: 34, height: 34, margin: '0 auto 8px', color: '#CBD5E1' }} /><div style={{ fontSize: 13 }}>No brands{query ? ' match your search' : ' yet'}.</div></div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
                    {shownBrands.map((b) => (
                      <div key={b.id} className="glass-card" data-testid={`brand-card-${b.id}`} style={{ padding: '18px', cursor: 'pointer', transition: 'transform .14s, box-shadow .14s' }}
                        onClick={() => navigate(`/admin/brands/${b.id}`)}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--card-shadow-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                          <span style={{ width: 46, height: 46, borderRadius: 14, flexShrink: 0, overflow: 'hidden', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 15, background: `linear-gradient(135deg, ${V}, #8B5CF6)` }}>
                            {b.image_url ? <img src={b.image_url} alt={b.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(b.name)}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                            <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#059669', background: '#ECFDF5', padding: '2px 8px', borderRadius: 9999 }}>Active</span>
                          </div>
                        </div>
                        <p style={{ fontSize: 12.5, color: '#64748B', lineHeight: 1.4, minHeight: 34, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{b.description || 'No description provided'}</p>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #EEF1F8', paddingTop: 10, marginTop: 12 }}>
                          <span style={{ fontSize: 10.5, fontFamily: 'monospace', color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{b.db_name}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: V }}>Open<ChevronRight style={{ width: 13, height: 13 }} /></span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="glass-card" style={{ padding: '18px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 14 }}>Portfolio</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[{ i: Users, l: 'Clients', v: clients.length }, { i: Building2, l: 'Brands', v: brands.length }].map((m) => (
                  <div key={m.l} style={{ background: V_WASH, borderRadius: 12, padding: '12px 14px' }}>
                    <m.i style={{ width: 16, height: 16, color: V }} />
                    <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 22, color: '#0F172A', marginTop: 6 }}>{m.v}</div>
                    <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#94A3B8' }}>{m.l}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card" style={{ padding: '18px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 12 }}>Brands by client</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {clients.map((c) => {
                  const max = Math.max(1, ...clients.map((x) => x.brands.length));
                  return (
                    <div key={c.name} style={{ cursor: 'pointer' }} onClick={() => openClient(c)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}><span style={{ color: '#3A4356', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span><span style={{ fontWeight: 800, color: '#0F172A' }}>{c.brands.length}</span></div>
                      <div style={{ height: 7, borderRadius: 6, background: '#F1F5F9', overflow: 'hidden' }}><div style={{ height: '100%', width: `${(c.brands.length / max) * 100}%`, background: c.color }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="glass-card" style={{ padding: '16px 18px', background: `linear-gradient(135deg, ${V_WASH}, #fff)` }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 800, color: '#0F172A' }}><Sparkles style={{ width: 16, height: 16, color: V }} /> Ask Colonel AI</div>
              <p style={{ fontSize: 12, color: '#64748B', margin: '6px 0 10px' }}>Ask about a client's brands, activity, or filings.</p>
              <button onClick={() => navigate('/chat')} style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: '#fff', background: V, border: 'none', borderRadius: 10, padding: '9px 12px', cursor: 'pointer' }}><Layers style={{ width: 14, height: 14 }} /> Open Colonel AI</button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent onClose={() => setShowModal(false)}>
          <DialogHeader><DialogTitle>Create New Brand</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div><Label htmlFor="name">Brand Name *</Label><Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Enter brand name" required data-testid="brand-name-input" /></div>
            <div><Label htmlFor="description">Description</Label><Input id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Enter description" data-testid="brand-description-input" /></div>
            <div><Label htmlFor="image_url">Image URL</Label><Input id="image_url" value={formData.image_url} onChange={(e) => setFormData({ ...formData, image_url: e.target.value })} placeholder="https://example.com/logo.png" data-testid="brand-image-input" /></div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowModal(false)} className="flex-1">Cancel</Button>
              <Button type="submit" className="flex-1" data-testid="brand-submit-button" style={{ background: V }}>Create Brand</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default BrandsPage;
