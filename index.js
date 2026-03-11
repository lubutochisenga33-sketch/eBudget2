const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.options('*', cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/mobile', express.static(path.join(__dirname, 'public/mobile')));
app.use('/admin',  express.static(path.join(__dirname, 'public/admin')));
app.get('/', (req, res) => res.redirect('/mobile/eBudget.html'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('Supabase configured:', process.env.SUPABASE_URL ? 'YES' : 'NO');

function adminAuth(req, res) {
  const adminUser = req.headers['admin-username'];
  const adminPass = req.headers['admin-password'];
  if (adminUser !== process.env.ADMIN_USERNAME || adminPass !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

function formatUser(u) {
  return {
    id:         u.id,
    name:       u.name,
    email:      u.email,
    phone:      u.phone || '',
    status:     u.status,
    approvedAt: u.approved_at,
    entries:    u.entries || [],
    budgets:    u.budgets  || {},
    createdAt:  u.created_at
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', async (req, res) => {
  try {
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
    res.json({ status: 'ok', message: 'eBudget server is running', storage: 'Supabase', users: count || 0 });
  } catch(e) {
    res.json({ status: 'ok', message: 'eBudget server is running', storage: 'Supabase' });
  }
});

// ============================================================
// AUTH — REGISTER
// ============================================================
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email.toLowerCase().trim()).single();

    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hashed = await bcrypt.hash(password, 10);

    const { error } = await supabase.from('users').insert({
      name:     name.trim(),
      email:    email.toLowerCase().trim(),
      phone:    phone ? phone.trim() : '',
      password: hashed,
      status:   'pending',
      entries:  [],
      budgets:  {}
    });

    if (error) throw error;

    res.status(201).json({ message: 'Registration successful. Your account is pending admin approval.' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// AUTH — LOGIN
// ============================================================
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('Login attempt for:', email);

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error) {
      console.log('Supabase error fetching user:', error.message);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user) {
      console.log('No user found for email:', email);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    console.log('User found, status:', user.status, '| has password:', !!user.password);

    if (!user.password) {
      console.log('ERROR: password field is null/missing from Supabase row');
      return res.status(500).json({ error: 'Account error. Please contact admin.' });
    }

    const match = await bcrypt.compare(password, user.password);
    console.log('Password match:', match);

    if (!match)
      return res.status(401).json({ error: 'Invalid email or password.' });

    // Auto-expire check
    if (user.status === 'approved' && user.approved_at) {
      const diffDays = (Date.now() - new Date(user.approved_at)) / (1000 * 60 * 60 * 24);
      if (diffDays >= 30) {
        await supabase.from('users').update({ status: 'expired' }).eq('id', user.id);
        return res.status(403).json({ error: 'expired', message: 'Your subscription has expired.' });
      }
    }

    if (user.status === 'pending')
      return res.status(403).json({ error: 'pending', message: 'Your account is pending admin approval.' });
    if (user.status === 'rejected')
      return res.status(403).json({ error: 'rejected', message: 'Your account has been rejected.' });
    if (user.status === 'expired')
      return res.status(403).json({ error: 'expired', message: 'Your subscription has expired.' });
    if (user.status !== 'approved')
      return res.status(403).json({ error: 'not_approved', message: 'Account not approved.' });

    res.json({ user: formatUser(user), session: 'session_' + Date.now() });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ENTRIES & BUDGETS — GET
// ============================================================
app.get('/entries/:userId', async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users').select('entries, budgets').eq('id', req.params.userId).single();

    if (error || !user) return res.status(404).json({ error: 'User not found.' });

    res.json({ entries: user.entries || [], budgets: user.budgets || {} });
  } catch (error) {
    console.error('Get entries error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ENTRIES & BUDGETS — SAVE
// ============================================================
app.put('/entries/:userId', async (req, res) => {
  try {
    const { entries, budgets } = req.body;
    const { error } = await supabase
      .from('users').update({ entries: entries || [], budgets: budgets || {} }).eq('id', req.params.userId);

    if (error) throw error;
    res.json({ message: 'Data saved successfully.' });
  } catch (error) {
    console.error('Save entries error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ADMIN — LIST USERS
// ============================================================
app.get('/admin/users', async (req, res) => {
  try {
    if (!adminAuth(req, res)) return;

    const { data: users, error } = await supabase
      .from('users').select('*').order('created_at', { ascending: false });

    if (error) throw error;

    const enriched = users.map(u => {
      const obj = formatUser(u);
      if (u.approved_at && u.status === 'approved') {
        const diffDays = Math.floor((Date.now() - new Date(u.approved_at)) / (1000 * 60 * 60 * 24));
        obj.daysLeft = Math.max(0, 30 - diffDays);
        if (diffDays >= 30) obj.status = 'expired';
      }
      return obj;
    });

    res.json(enriched);
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ADMIN — APPROVE
// ============================================================
app.patch('/admin/approve/:id', async (req, res) => {
  try {
    if (!adminAuth(req, res)) return;

    const { data: user, error } = await supabase
      .from('users')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    if (error || !user) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: user.name + ' approved.', user: formatUser(user) });
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ADMIN — REJECT
// ============================================================
app.patch('/admin/reject/:id', async (req, res) => {
  try {
    if (!adminAuth(req, res)) return;

    const { data: user, error } = await supabase
      .from('users').update({ status: 'rejected' }).eq('id', req.params.id).select().single();

    if (error || !user) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: user.name + ' rejected.', user: formatUser(user) });
  } catch (error) {
    console.error('Reject error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ADMIN — DELETE USER
// ============================================================
app.delete('/admin/user/:id', async (req, res) => {
  try {
    if (!adminAuth(req, res)) return;

    const { data: user, error: fetchError } = await supabase
      .from('users').select('name').eq('id', req.params.id).single();

    if (fetchError || !user) return res.status(404).json({ error: 'User not found.' });

    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ message: user.name + ' deleted permanently.' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║    eBudget Backend Server                                 ║
║    ✅ Running on port ${PORT}                                ║
║    🗄️  Storage: Supabase PostgreSQL                      ║
║    🔒 Passwords: bcrypt hashed                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
