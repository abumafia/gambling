const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ma'lumotlar bazasi (oddiy JSON fayllar)
const usersFile = './data/users.json';
const adsFile = './data/ads.json';
const withdrawalsFile = './data/withdrawals.json';
const statsFile = './data/stats.json';

// Ma'lumotlar bazasini yuklash funksiyasi
function loadData(filename) {
  try {
    if (!fs.existsSync(filename)) {
      fs.mkdirSync('./data', { recursive: true });
      fs.writeFileSync(filename, JSON.stringify([]));
    }
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    return [];
  }
}

// Ma'lumotlarni saqlash funksiyasi
function saveData(filename, data) {
  try {
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Ma\'lumotlarni saqlashda xatolik:', error);
    return false;
  }
}

// Statistikani yangilash
function updateStats(amount, type) {
  const stats = loadData(statsFile);
  const today = new Date().toISOString().split('T')[0];
  
  let todayStats = stats.find(s => s.date === today);
  if (!todayStats) {
    todayStats = { date: today, earned: 0, paid: 0 };
    stats.push(todayStats);
  }
  
  if (type === 'earned') todayStats.earned += amount;
  if (type === 'paid') todayStats.paid += amount;
  
  saveData(statsFile, stats);
}

// API yo'llari

// Foydalanuvchi ma'lumotlarini olish
app.get('/api/user/:id', (req, res) => {
  const users = loadData(usersFile);
  const user = users.find(u => u.id === req.params.id);
  if (user) {
    res.json(user);
  } else {
    res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  }
});

// Foydalanuvchi yaratish yoki login qilish
app.post('/api/user', (req, res) => {
  const { username, password, referral } = req.body;
  const users = loadData(usersFile);
  
  // Foydalanuvchini tekshirish
  let user = users.find(u => u.username === username && u.password === password);
  
  if (!user) {
    // Yangi foydalanuvchi yaratish
    const newUser = {
      id: Date.now().toString(),
      username,
      password,
      balance: 0,
      referralCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
      referredBy: referral || null,
      createdAt: new Date().toISOString()
    };
    
    users.push(newUser);
    saveData(usersFile, users);
    
    // Agar referral bo'yicha kelgan bo'lsa, referrer'ga bonus berish
    if (referral) {
      const referrer = users.find(u => u.referralCode === referral);
      if (referrer) {
        referrer.balance += 100;
        saveData(usersFile, users);
        updateStats(100, 'earned');
      }
    }
    
    user = newUser;
  }
  
  res.json({ success: true, user: { id: user.id, username: user.username, balance: user.balance, referralCode: user.referralCode } });
});

// Reklama ko'rish
app.post('/api/watch-ad', (req, res) => {
  const { userId } = req.body;
  const users = loadData(usersFile);
  const ads = loadData(adsFile);
  
  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  }
  
  // Faol reklamalarni topish
  const activeAds = ads.filter(ad => ad.status === 'active' && ad.views < ad.maxViews);
  
  if (activeAds.length === 0) {
    return res.status(400).json({ error: 'Hozircha reklamalar mavjud emas' });
  }
  
  // Tasodifiy reklama tanlash
  const randomAd = activeAds[Math.floor(Math.random() * activeAds.length)];
  
  // Reklama ko'rishlar sonini yangilash
  randomAd.views += 1;
  saveData(adsFile, ads);
  
  // Foydalanuvchi balansini yangilash
  user.balance += 50;
  saveData(usersFile, users);
  updateStats(50, 'earned');
  
  res.json({ success: true, ad: randomAd, newBalance: user.balance });
});

// Reklama yaratish
app.post('/api/create-ad', (req, res) => {
  const { type, title, description, link, image, video, maxViews, advertiser } = req.body;
  const ads = loadData(adsFile);
  
  const newAd = {
    id: Date.now().toString(),
    type,
    title,
    description,
    link,
    image,
    video,
    maxViews: parseInt(maxViews),
    views: 0,
    advertiser,
    status: 'pending',
    createdAt: new Date().toISOString(),
    cost: parseInt(maxViews) * 1500
  };
  
  ads.push(newAd);
  saveData(adsFile, ads);
  
  res.json({ success: true, ad: newAd });
});

// Pul yechish so'rovini yuborish
app.post('/api/withdraw', (req, res) => {
  const { userId, cardNumber, cardHolder, amount } = req.body;
  const users = loadData(usersFile);
  const withdrawals = loadData(withdrawalsFile);
  
  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  }
  
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Balansingizda yetarli mablag\' yo\'q' });
  }
  
  if (amount < 5000) {
    return res.status(400).json({ error: 'Minimal yechish miqdori 5000 so\'m' });
  }
  
  // Pul yechish so'rovini yaratish
  const withdrawal = {
    id: Date.now().toString(),
    userId,
    cardNumber,
    cardHolder,
    amount: parseInt(amount),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  withdrawals.push(withdrawal);
  saveData(withdrawalsFile, withdrawals);
  
  res.json({ success: true, withdrawal });
});

// Admin API yo'llari

// Barcha reklama so'rovlarini olish
app.get('/api/admin/ads', (req, res) => {
  const ads = loadData(adsFile);
  res.json(ads);
});

// Reklamani tasdiqlash/rad etish
app.post('/api/admin/ad/:id', (req, res) => {
  const { status } = req.body;
  const ads = loadData(adsFile);
  
  const ad = ads.find(a => a.id === req.params.id);
  if (!ad) {
    return res.status(404).json({ error: 'Reklama topilmadi' });
  }
  
  ad.status = status;
  saveData(adsFile, ads);
  
  res.json({ success: true, ad });
});

// Barcha foydalanuvchilarni olish
app.get('/api/admin/users', (req, res) => {
  const users = loadData(usersFile);
  res.json(users);
});

// Foydalanuvchi balansini yangilash
app.post('/api/admin/user/:id/balance', (req, res) => {
  const { balance } = req.body;
  const users = loadData(usersFile);
  
  const user = users.find(u => u.id === req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  }
  
  user.balance = parseInt(balance);
  saveData(usersFile, users);
  
  res.json({ success: true, user });
});

// Barcha pul yechish so'rovlarini olish
app.get('/api/admin/withdrawals', (req, res) => {
  const withdrawals = loadData(withdrawalsFile);
  res.json(withdrawals);
});

// Pul yechish so'rovini tasdiqlash/rad etish
app.post('/api/admin/withdrawal/:id', (req, res) => {
  const { status } = req.body;
  const withdrawals = loadData(withdrawalsFile);
  const users = loadData(usersFile);
  
  const withdrawal = withdrawals.find(w => w.id === req.params.id);
  if (!withdrawal) {
    return res.status(404).json({ error: 'So\'rov topilmadi' });
  }
  
  const user = users.find(u => u.id === withdrawal.userId);
  if (!user) {
    return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  }
  
  if (status === 'approved') {
    // Pul yechilganligini belgilash
    user.balance -= withdrawal.amount;
    saveData(usersFile, users);
    updateStats(withdrawal.amount, 'paid');
  }
  
  withdrawal.status = status;
  saveData(withdrawalsFile, withdrawals);
  
  res.json({ success: true, withdrawal });
});

// Statistikani olish
app.get('/api/admin/stats', (req, res) => {
  const stats = loadData(statsFile);
  const users = loadData(usersFile);
  const withdrawals = loadData(withdrawalsFile);
  
  const totalEarned = stats.reduce((sum, s) => sum + s.earned, 0);
  const totalPaid = stats.reduce((sum, s) => sum + s.paid, 0);
  const totalUsers = users.length;
  
  res.json({ totalEarned, totalPaid, totalUsers, dailyStats: stats });
});

// Admin reklama yaratish
app.post('/api/admin/ad', (req, res) => {
  const { type, title, description, link, image, video } = req.body;
  const ads = loadData(adsFile);
  
  const newAd = {
    id: Date.now().toString(),
    type,
    title,
    description,
    link,
    image,
    video,
    maxViews: 999999, // Cheksiz ko'rinish
    views: 0,
    advertiser: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
    cost: 0
  };
  
  ads.push(newAd);
  saveData(adsFile, ads);
  
  res.json({ success: true, ad: newAd });
});

// Sahifalarni yuklash
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register-login.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/setads.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setads.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});