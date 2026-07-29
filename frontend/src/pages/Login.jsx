import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { toast } from 'sonner';
import { Shield } from 'lucide-react';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState('');
  const { login, startGoogleLogin, finishGoogleLogin } = useAuth();
  const navigate = useNavigate();

  // Same role → home mapping used by both password and Google login.
  const routeByRole = (user) => {
    if (user.role === 'admin') navigate('/admin');
    else if (user.role === 'developer') navigate('/feedback');
    // Accountants land on the brand picker; they choose a brand, then the card
    // opens that brand's Dashboard.
    else if (user.role === 'accountant') navigate('/brands');
    else if (user.role === 'brand_executive') navigate('/dashboard');
    else navigate('/dashboard');
  };

  // Complete the Google flow when Composio redirects back to /login?google_login=<nonce>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nonce = params.get('google_login');
    if (!nonce) return;
    // Strip the param so a refresh doesn't re-run finish (nonce is single-use).
    window.history.replaceState({}, '', '/login');
    setGoogleBusy(true);
    finishGoogleLogin(nonce)
      .then((user) => {
        toast.success('Login successful!');
        routeByRole(user);
      })
      .catch((error) => setGoogleError(error.response?.data?.error || 'Google sign-in failed.'))
      .finally(() => setGoogleBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGoogle = async () => {
    setGoogleError('');
    setGoogleBusy(true);
    try {
      await startGoogleLogin(); // navigates away to Google consent
    } catch (error) {
      setGoogleError(error.response?.data?.error || 'Google sign-in unavailable.');
      setGoogleBusy(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const user = await login(email, password);
      toast.success('Login successful!');
      routeByRole(user);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" data-testid="login-page">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto w-12 h-12 bg-slate-900 rounded-lg flex items-center justify-center">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <CardTitle className="text-2xl font-bold">Colonel</CardTitle>
          <CardDescription>Precision Accounting Automation</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="login-email-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="login-password-input"
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loading}
              data-testid="login-submit-button"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className="flex items-center gap-3 my-4">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full flex items-center justify-center gap-2"
            onClick={handleGoogle}
            disabled={googleBusy}
            data-testid="login-google-button"
          >
            <img
              src="https://www.google.com/favicon.ico"
              alt=""
              width={18}
              height={18}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            {googleBusy ? 'Signing in…' : 'Sign in with Google'}
          </Button>
          {googleError ? (
            <p className="text-sm text-red-600 mt-2 text-center" data-testid="login-google-error">
              {googleError}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;