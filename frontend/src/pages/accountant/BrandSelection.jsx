import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Building2, ArrowRight, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../lib/api';
import { toast } from 'sonner';

const BrandSelection = () => {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchBrands();
  }, []);

  const fetchBrands = async () => {
    try {
      const response = await api.get('/api/brands/my-brands');
      setBrands(response.data);
    } catch (error) {
      toast.error('Failed to load brands');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900 mx-auto"></div>
          <p className="mt-4 text-slate-600">Loading brands...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50" data-testid="brand-selection-page">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Colonel</h1>
            <p className="text-sm text-slate-600 mt-1">Welcome, {user?.name}</p>
          </div>
          <Button
            variant="ghost"
            onClick={handleLogout}
            data-testid="logout-button"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Select a Brand</h2>
          <p className="text-slate-600 mt-2">Choose a brand to access its dashboard and agents</p>
        </div>

        {brands.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Building2 className="h-12 w-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900 mb-2">No Brands Assigned</h3>
              <p className="text-slate-600">You don't have access to any brands yet. Please contact your administrator.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="brands-grid">
            {brands.map((brand) => (
              <Card
                key={brand.id}
                className="hover:shadow-lg transition-shadow cursor-pointer"
                onClick={() => navigate(`/brands/${brand.id}/dashboard`)}
                data-testid={`brand-card-${brand.id}`}
              >
                <CardHeader>
                  <div className="w-16 h-16 bg-slate-100 rounded-lg flex items-center justify-center mb-4">
                    {brand.image_url ? (
                      <img src={brand.image_url} alt={brand.name} className="w-full h-full object-cover rounded-lg" />
                    ) : (
                      <Building2 className="h-8 w-8 text-slate-600" />
                    )}
                  </div>
                  <CardTitle>{brand.name}</CardTitle>
                  <CardDescription className="line-clamp-2">{brand.description || 'No description available'}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" data-testid={`select-brand-${brand.id}`}>
                    Open Dashboard
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default BrandSelection;