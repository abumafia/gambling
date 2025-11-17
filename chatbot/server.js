const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'secret-key', // O'zgartiring
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Productionda true qiling
}));

// MongoDB ulanish
mongoose.connect(process.env.DB_URL, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB ulandi'))
    .catch(err => console.error('MongoDB xatosi:', err));

// User modeli
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true }
});
const User = mongoose.model('User', userSchema);

// Ro'yxatdan o'tish
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPw = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashedPw });
        await user.save();
        req.session.user = { username };
        res.redirect('/index.html');
    } catch (err) {
        res.status(400).send('Xato: Foydalanuvchi mavjud');
    }
});

// Login
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = { username };
            res.redirect('/index.html');
        } else {
            res.status(400).send('Noto\'g\'ri ma\'lumotlar');
        }
    } catch (err) {
        res.status(500).send('Server xatosi');
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/register-login.html');
});

// Session tekshirish middleware
const isLoggedIn = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/register-login.html');
    }
};

// Sahifalarni himoyalash
app.get('/chat.html', isLoggedIn, (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin.html', isLoggedIn, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/session-check', (req, res) => {
    res.status(req.session.user ? 200 : 401).send();
});

// Socket.io uchun server
const server = require('http').createServer(app);
const io = require('socket.io')(server);

// Chatbot funksiyasi (oddiy pattern-based javoblar)
const responses = {
    'salom': 'Assalomu alaykum! Qanday yordam bera olaman?',
    'qalaysiz': 'Yaxshiman, rahmat! Sizchi?',
    'xayr': 'Xayr! Keyin ko\'rishguncha.',
    default: 'Kechirasiz, tushunmadim. Yana urinib ko\'ring.'
};

io.on('connection', (socket) => {
    console.log('Foydalanuvchi ulandi');
    socket.on('chat message', (msg) => {
        let reply = responses[msg.toLowerCase()] || responses.default;
        io.emit('chat message', { user: 'Bot', msg });
        setTimeout(() => io.emit('chat message', { user: 'Bot', msg: reply }), 500);
    });
    socket.on('disconnect', () => console.log('Foydalanuvchi uzildi'));
});

server.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));