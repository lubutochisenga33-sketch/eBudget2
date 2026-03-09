const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const cloudinary = require('cloudinary').v2;
const bcrypt     = require('bcryptjs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
  origin: [
    'https://ebudget-tlg8.onrender.com',
    'http://localhost:3000'
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','admin-username','admin-password']
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve frontend files
app.use('/mobile', express.static(path.join(__dirname, 'public/mobile')));
app.use('/admin',  express.static(path.join(__dirname, 'public/admin')));

// Root redirect → mobile app
app.get('/', (req, res) => res.redirect('/mobile/eBudget.html'));

// ============================================================
// CLOUDINARY CONFIGURATION
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log('Cloudinary configured:', process.env.CLOUDINARY_CLOUD_NAME ? 'YES' : 'NO');

// ============================================================
// IN-MEMORY DATA STORE
// ============================================================
let users = [];
// users shape: { id, name, email, phone, password (hashed), status, approvedAt, entries, budgets, createdAt }

// ============================================================
// CLOUDINARY PERSISTENCE  (same pattern as MUK)
// ============================================================
async function loadDataFromCloudinary() {
  try {
    console.log('Loading data from Cloudinary...');
    const result = await cloudinary.api.resource('ebudget-data/database', { resource_type: 'raw' });

    const https = require('https');
    const dataString = await new Promise((resolve, reject) => {
      https.get(result.secure_url, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const data = JSON.parse(dataString);
    users = data.users || [];
    console.log(`✅ Data loaded: ${users.length} users`);
  } catch (error) {
    console.log('ℹ️  No existing data found, starting fresh');
  }
}

async function saveDataToCloudinary() {
  try {
    const data = {
      users,
      lastUpdated: new Date().toISOString()
    };

    const jsonString = JSON.stringify(data, null, 2);

    await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          public_id:     'ebudget-data/database',
          overwrite:     true,
          invalidate:    true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(Buffer.from(jsonString));
    });

    console.log('✅ Data saved to Cloudinary at', new Date().toLocaleTimeString());
    return true;
  } catch (error) {
    console.error('❌ Error saving data:', error.message);
    return false;
  }
}

// Auto-save every 10 seconds (same as MUK)
setInterval(() => saveDataToCloudinary(), 10000);

// ============================================================
// HELPERS
// ============================================================
function checkExpiry(user) {
  if (user.status === 'approved' && user.approvedAt) {
    const diffDays = (Date.now() - new Date(user.approvedAt)) / (1000 * 60 * 60 * 24);
    if (diffDays >= 30) {
      user.status = 'expired';
      return true;
    }
  }
  return false;
}

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    message:   'eBudget server is running',
    storage:   'Cloudinary',
    cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'missing',
    users:     users.length
  });
});

// ============================================================
// AUTH — REGISTER
// ============================================================
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (users.find(u => u.email === email.toLowerCase().trim())) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      id:          Date.now().toString(),
      name:        name.trim(),
      email:       email.toLowerCase().trim(),
      phone:       phone ? phone.trim() : '',
      password:    hashed,
      status:      'pending',
      approvedAt:  null,
      entries:     [],
      budgets:     {},
      createdAt:   new Date().toISOString()
    };

    users.push(newUser);
    await saveDataToCloudinary();

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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = users.find(u => u.email === email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    // Auto-expire check
    const expired = checkExpiry(user);
    if (expired) await saveDataToCloudinary();

    if (user.status === 'pending')  return res.status(403).json({ error: 'pending',  message: 'Your account is pending admin approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'rejected', message: 'Your account has been rejected. Contact the admin.' });
    if (user.status === 'expired')  return res.status(403).json({ error: 'expired',  message: 'Your subscription has expired. Contact admin to renew.' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'not_approved', message: 'Account not approved.' });

    res.json({
      user: safeUser(user),
      session: 'session_' + Date.now()
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ENTRIES & BUDGETS — GET
// ============================================================
app.get('/entries/:userId', (req, res) => {
  try {
    const user = users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({
      entries: user.entries || [],
      budgets: user.budgets || {}
    });
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
    const idx = users.findIndex(u => u.id === req.params.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });

    users[idx].entries = entries || [];
    users[idx].budgets = budgets || {};

    await saveDataToCloudinary();
    res.json({ message: 'Data saved successfully.' });
  } catch (error) {
    console.error('Save entries error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// ADMIN — LIST USERS
// ============================================================
app.get('/admin/users', (req, res) => {
  try {
    const adminUser = req.headers['admin-username'];
    const adminPass = req.headers['admin-password'];
    if (adminUser !== process.env.ADMIN_USERNAME || adminPass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    // Enrich with days left
    const enriched = users.map(u => {
      const obj = safeUser(u);
      if (u.approvedAt && u.status === 'approved') {
        const diffDays = Math.floor((Date.now() - new Date(u.approvedAt)) / (1000 * 60 * 60 * 24));
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
    const adminUser = req.headers['admin-username'];
    const adminPass = req.headers['admin-password'];
    if (adminUser !== process.env.ADMIN_USERNAME || adminPass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });

    users[idx].status     = 'approved';
    users[idx].approvedAt = new Date().toISOString();
    await saveDataToCloudinary();

    res.json({ message: users[idx].name + ' approved.', user: safeUser(users[idx]) });
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
    const adminUser = req.headers['admin-username'];
    const adminPass = req.headers['admin-password'];
    if (adminUser !== process.env.ADMIN_USERNAME || adminPass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });

    users[idx].status = 'rejected';
    await saveDataToCloudinary();

    res.json({ message: users[idx].name + ' rejected.', user: safeUser(users[idx]) });
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
    const adminUser = req.headers['admin-username'];
    const adminPass = req.headers['admin-password'];
    if (adminUser !== process.env.ADMIN_USERNAME || adminPass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found.' });

    const deleted = users[idx];
    users.splice(idx, 1);
    await saveDataToCloudinary();

    res.json({ message: deleted.name + ' deleted permanently.' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
loadDataFromCloudinary().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║    eBudget Backend Server                                 ║
║                                                           ║
║    ✅ Server running on port ${PORT}                         ║
║    ☁️  Storage: Cloudinary                               ║
║    💾 Auto-save: Every 10 seconds                        ║
║    👥 Users: ${users.length}                                       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
});

// Save before shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down, saving data...');
  await saveDataToCloudinary();
  process.exit(0);
});
