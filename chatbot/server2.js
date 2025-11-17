const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const MongoStore = require('connect-mongo');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB ulanish
mongoose.connect('mongodb+srv://apl:apl00@gamepaymentbot.ffcsj5v.mongodb.net/schb?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Modellar
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  profilePic: { type: String, default: '' },
  bio: { type: String, default: '' },
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  balance: { type: Number, default: 0 }, // Virtual pul balans (monetizatsiya uchun)
  isPremium: { type: Boolean, default: false }, // Premium obuna holati
  premiumExpiresAt: { type: Date, default: null }, // Premium tugash sanasi
  coins: { type: Number, default: 0 }, // Ichki valyuta (sotib olish uchun)
  createdAt: { type: Date, default: Date.now }
});

const PostSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  media: { type: String, default: '' },
  isSponsored: { type: Boolean, default: false }, // Sponsor post (monetizatsiya)
  sponsorPrice: { type: Number, default: 0 }, // Sponsor narxi
  boostLevel: { type: Number, default: 0 }, // Postni ko'tarish darajasi (pullik)
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    replies: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      content: { type: String, required: true },
      likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      createdAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  isTip: { type: Boolean, default: false }, // Tip xabari (monetizatsiya)
  tipAmount: { type: Number, default: 0 }, // Tip miqdori
  createdAt: { type: Date, default: Date.now }
});

// Monetizatsiya uchun yangi model: Obuna
const SubscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['premium', 'basic'], default: 'basic' }, // Obuna turi
  price: { type: Number, required: true }, // Narx
  duration: { type: String, enum: ['monthly', 'yearly'], required: true }, // Davomiylik
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' }
});

const User = mongoose.model('User', UserSchema);
const Post = mongoose.model('Post', PostSchema);
const Message = mongoose.model('Message', MessageSchema);
const Subscription = mongoose.model('Subscription', SubscriptionSchema);

// Uploads papkasini yaratish
const uploadsDir = 'public/uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer sozlamalari
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Faqat rasm fayllari ruxsat etilgan!'), false);
    }
  }
});

// Middleware
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'social-network-secret-key-' + Math.random().toString(36).substring(2),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 1 kun
    store: MongoStore.create({
    mongoUrl: 'mongodb+srv://apl:apl00@gamepaymentbot.ffcsj5v.mongodb.net/schb?retryWrites=true&w=majority',
    ttl: 24 * 60 * 60 // 1 kun
  })
  }
}));

// Auth middleware
const requireLogin = (req, res, next) => {
  if (!req.session.userId) {
    if (req.xhr || req.headers.accept.indexOf('json') > -1) {
      return res.status(401).json({ success: false, message: "Avtorizatsiya talab qilinadi" });
    } else {
      return res.redirect('/register-login.html');
    }
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ success: false, message: "Admin huquqi kerak" });
  }
  next();
};

// Monetizatsiya middleware: Premium tekshirish
const requirePremium = (req, res, next) => {
  User.findById(req.session.userId, (err, user) => {
    if (err || !user || !user.isPremium || (user.premiumExpiresAt && user.premiumExpiresAt < new Date())) {
      return res.status(403).json({ success: false, message: "Premium obuna kerak" });
    }
    next();
  });
};

// Routes

// Asosiy sahifa
app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Profil sahifasi
app.get('/profile', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Admin sahifasi
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Ro'yxatdan o'tish
app.post('/register', async (req, res) => {
  try {
    const { username, password, email, fullName } = req.body;
    
    // Validatsiya
    if (!username || !password || !email || !fullName) {
      return res.status(400).json({ success: false, message: "Barcha maydonlarni to'ldiring" });
    }
    
    // Parolni hash qilish
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Yangi foydalanuvchi yaratish
    const newUser = new User({
      username,
      password: hashedPassword,
      email,
      fullName
    });
    
    await newUser.save();
    
    // Sessionga saqlash
    req.session.userId = newUser._id;
    req.session.username = newUser.username;
    req.session.isAdmin = newUser.username === 'admin';
    
    res.json({ success: true, message: "Ro'yxatdan muvaffaqiyatli o'tdingiz", userId: newUser._id });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Foydalanuvchi nomi yoki email allaqachon mavjud" });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// Kirish
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validatsiya
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Foydalanuvchi nomi va parolni kiriting" });
    }
    
    // Foydalanuvchini topish
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ success: false, message: "Foydalanuvchi topilmadi" });
    }
    
    // Parolni tekshirish
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Noto'g'ri parol" });
    }
    
    // Sessionga saqlash
    req.session.userId = user._id;
    req.session.username = user.username;
    req.session.isAdmin = user.username === 'admin';
    
    res.json({ success: true, message: "Muvaffaqiyatli kirdingiz", userId: user._id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Chiqish
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: "Chiqishda xatolik" });
    }
    res.json({ success: true, message: "Muvaffaqiyatli chiqdingiz" });
  });
});

// Foydalanuvchini o'zini olish (monetizatsiya ma'lumotlari bilan)
app.get('/user/me', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId)
      .select('-password')
      .populate('followers', 'username fullName profilePic')
      .populate('following', 'username fullName profilePic');
    
    if (!user) {
      return res.status(404).json({ success: false, message: "Foydalanuvchi topilmadi" });
    }
    
    const posts = await Post.find({ userId: user._id });
    const totalLikes = posts.reduce((sum, post) => sum + post.likes.length, 0);
    
    // Monetizatsiya statistikasi
    const earnings = posts.reduce((sum, post) => sum + (post.isSponsored ? post.sponsorPrice : 0), 0);
    
    res.json({
      success: true,
      user: {
        ...user.toObject(),
        postCount: posts.length,
        totalLikes,
        earnings // Monetizatsiya daromadi
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Foydalanuvchi ma'lumotlarini olish
app.get('/user/:id', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('followers', 'username fullName profilePic')
      .populate('following', 'username fullName profilePic');
    
    if (!user) {
      return res.status(404).json({ success: false, message: "Foydalanuvchi topilmadi" });
    }
    
    const posts = await Post.find({ userId: user._id });
    const totalLikes = posts.reduce((sum, post) => sum + post.likes.length, 0);
    
    res.json({
      success: true,
      user: {
        ...user.toObject(),
        postCount: posts.length,
        totalLikes
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Foydalanuvchini yangilash
app.put('/user', requireLogin, async (req, res) => {
  try {
    const { fullName, bio } = req.body;
    
    const user = await User.findByIdAndUpdate(
      req.session.userId,
      { fullName, bio },
      { new: true, runValidators: true }
    ).select('-password');
    
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Rasm yuklash
app.post('/upload', requireLogin, upload.single('profilePic'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fayl yuklanmadi' });
    }
    
    const user = await User.findByIdAndUpdate(
      req.session.userId,
      { profilePic: '/uploads/' + req.file.filename },
      { new: true }
    ).select('-password');
    
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Story Schema
const StorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  media: { type: String, required: true },
  caption: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const Story = mongoose.model('Story', StorySchema);

// Story yaratish (premium foydalanuvchilar uchun cheksiz)
app.post('/stories', requireLogin, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Media fayl kerak' });
    }
    
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 soat
    
    const newStory = new Story({
      userId: req.session.userId,
      media: '/uploads/' + req.file.filename,
      caption: req.body.caption || '',
      expiresAt
    });
    
    await newStory.save();
    await newStory.populate('userId', 'username fullName profilePic');
    
    res.json({ success: true, story: newStory });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Follow qilingan userlarning storylarini olish
app.get('/stories', requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const followingIds = user.following;
    
    const stories = await Story.find({
      userId: { $in: followingIds },
      expiresAt: { $gt: new Date() }
    })
    .populate('userId', 'username fullName profilePic')
    .sort({ createdAt: -1 });
    
    res.json({ success: true, stories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Post yaratish (sponsor va boost qo'shish)
app.post('/posts', requireLogin, async (req, res) => {
  try {
    const { content, media, isSponsored, sponsorPrice, boostLevel } = req.body;
    
    if (!content) {
      return res.status(400).json({ success: false, message: "Post matni bo'sh bo'lmasligi kerak" });
    }
    
    // Boost uchun balans tekshirish
    if (boostLevel > 0) {
      const user = await User.findById(req.session.userId);
      const cost = boostLevel * 10; // Har daraja 10 coin
      if (user.coins < cost) {
        return res.status(400).json({ success: false, message: "Yetarli coin yo'q" });
      }
      user.coins -= cost;
      await user.save();
    }
    
    const newPost = new Post({
      userId: req.session.userId,
      content,
      media: media || '',
      isSponsored: isSponsored || false,
      sponsorPrice: sponsorPrice || 0,
      boostLevel: parseInt(boostLevel) || 0
    });
    
    await newPost.save();
    await newPost.populate('userId', 'username fullName profilePic');
    
    res.json({ success: true, post: newPost });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Postlarni olish (boostlanganlarni yuqorida ko'rsatish)
app.get('/posts', requireLogin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    
    // Boost darajasiga qarab saralash
    const posts = await Post.find()
      .populate('userId', 'username fullName profilePic')
      .populate({
        path: 'comments.userId',
        select: 'username fullName profilePic'
      })
      .populate({
        path: 'comments.replies.userId',
        select: 'username fullName profilePic'
      })
      .sort({ 
        boostLevel: -1, // Boost yuqori
        createdAt: -1 
      })
      .skip(skip)
      .limit(limit);
    
    res.json({ success: true, posts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// User ID bo'yicha postlarni olish
app.get('/posts/user/:userId', requireLogin, async (req, res) => {
  try {
    const posts = await Post.find({ userId: req.params.userId })
      .populate('userId', 'username fullName profilePic')
      .sort({ createdAt: -1 });
    
    res.json({ success: true, posts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Post like qilish
app.post('/posts/:id/like', requireLogin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ success: false, message: "Post topilmadi" });
    }
    
    const likeIndex = post.likes.indexOf(req.session.userId);
    if (likeIndex > -1) {
      post.likes.splice(likeIndex, 1);
    } else {
      post.likes.push(req.session.userId);
    }
    
    await post.save();
    res.json({ success: true, likes: post.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Komment qo'shish
app.post('/posts/:id/comment', requireLogin, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content) {
      return res.status(400).json({ success: false, message: "Komment matni bo'sh bo'lmasligi kerak" });
    }
    
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ success: false, message: "Post topilmadi" });
    }
    
    post.comments.push({
      userId: req.session.userId,
      content
    });
    
    await post.save();
    await post.populate({
      path: 'comments.userId',
      select: 'username fullName profilePic'
    });
    
    const newComment = post.comments[post.comments.length - 1];
    res.json({ success: true, comment: newComment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Komment like qilish
app.post('/posts/:postId/comments/:commentId/like', requireLogin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    
    if (!post) {
      return res.status(404).json({ success: false, message: "Post topilmadi" });
    }
    
    const comment = post.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: "Komment topilmadi" });
    }
    
    const likeIndex = comment.likes.indexOf(req.session.userId);
    if (likeIndex > -1) {
      comment.likes.splice(likeIndex, 1);
    } else {
      comment.likes.push(req.session.userId);
    }
    
    await post.save();
    res.json({ success: true, likes: comment.likes.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Kommentga javob berish
app.post('/posts/:postId/comments/:commentId/reply', requireLogin, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content) {
      return res.status(400).json({ success: false, message: "Javob matni bo'sh bo'lmasligi kerak" });
    }
    
    const post = await Post.findById(req.params.postId);
    
    if (!post) {
      return res.status(404).json({ success: false, message: "Post topilmadi" });
    }
    
    const comment = post.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: "Komment topilmadi" });
    }
    
    comment.replies.push({
      userId: req.session.userId,
      content
    });
    
    await post.save();
    await post.populate({
      path: 'comments.replies.userId',
      select: 'username fullName profilePic'
    });
    
    const newReply = comment.replies[comment.replies.length - 1];
    res.json({ success: true, reply: newReply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Obuna bo'lish
app.post('/user/:id/follow', requireLogin, async (req, res) => {
  try {
    const userToFollow = await User.findById(req.params.id);
    const currentUser = await User.findById(req.session.userId);
    
    if (!userToFollow || !currentUser) {
      return res.status(404).json({ success: false, message: "Foydalanuvchi topilmadi" });
    }
    
    // Obuna bo'lish/obunani bekor qilish
    const isFollowing = currentUser.following.includes(userToFollow._id);
    
    if (isFollowing) {
      // Obunani bekor qilish
      currentUser.following.pull(userToFollow._id);
      userToFollow.followers.pull(currentUser._id);
    } else {
      // Obuna bo'lish
      currentUser.following.push(userToFollow._id);
      userToFollow.followers.push(currentUser._id);
    }
    
    await currentUser.save();
    await userToFollow.save();
    
    res.json({ 
      success: true, 
      isFollowing: !isFollowing,
      followers: userToFollow.followers.length 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Xabarlarni olish
app.get('/messages/:userId', requireLogin, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { senderId: req.session.userId, receiverId: req.params.userId },
        { senderId: req.params.userId, receiverId: req.session.userId }
      ]
    })
    .populate('senderId', 'username fullName profilePic')
    .populate('receiverId', 'username fullName profilePic')
    .sort({ createdAt: 1 });
    
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Xabar yuborish (tip qo'shish)
app.post('/messages', requireLogin, async (req, res) => {
  try {
    const { receiverId, content, tipAmount } = req.body;
    
    if (!content || !receiverId) {
      return res.status(400).json({ success: false, message: "Xabar matni va qabul qiluvchi kerak" });
    }
    
    // Tip uchun balans tekshirish
    if (tipAmount > 0) {
      const sender = await User.findById(req.session.userId);
      if (sender.balance < tipAmount) {
        return res.status(400).json({ success: false, message: "Yetarli balans yo'q" });
      }
      sender.balance -= tipAmount;
      const receiver = await User.findById(receiverId);
      receiver.balance += tipAmount;
      await sender.save();
      await receiver.save();
    }
    
    const newMessage = new Message({
      senderId: req.session.userId,
      receiverId,
      content,
      isTip: tipAmount > 0,
      tipAmount: tipAmount || 0
    });
    
    await newMessage.save();
    await newMessage.populate('senderId', 'username fullName profilePic');
    await newMessage.populate('receiverId', 'username fullName profilePic');
    
    res.json({ success: true, message: newMessage });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// O'qilmagan xabarlarni sanash
app.get('/messages/unread/count', requireLogin, async (req, res) => {
  try {
    const count = await Message.countDocuments({
      receiverId: req.session.userId,
      isRead: false
    });
    
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Xabarlarni o'qilgan deb belgilash
app.post('/messages/:userId/read', requireLogin, async (req, res) => {
  try {
    await Message.updateMany(
      {
        senderId: req.params.userId,
        receiverId: req.session.userId,
        isRead: false
      },
      { isRead: true }
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Monetizatsiya: Premium obuna sotib olish (simulyatsiya, haqiqiyda Stripe ishlatish mumkin)
app.post('/subscribe/premium', requireLogin, async (req, res) => {
  try {
    const { duration, price } = req.body; // Masalan, {duration: 'monthly', price: 9.99}
    
    // Balans tekshirish (virtual)
    const user = await User.findById(req.session.userId);
    if (user.balance < price) {
      return res.status(400).json({ success: false, message: "Yetarli balans yo'q. To'ldiring." });
    }
    
    user.balance -= price;
    user.isPremium = true;
    const endDate = duration === 'monthly' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    user.premiumExpiresAt = endDate;
    await user.save();
    
    // Obuna yozuvini saqlash
    const newSub = new Subscription({
      userId: req.session.userId,
      type: 'premium',
      price,
      duration,
      endDate
    });
    await newSub.save();
    
    res.json({ success: true, message: "Premium obuna faollashtirildi", expiresAt: endDate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Monetizatsiya: Coin sotib olish (simulyatsiya)
app.post('/buy/coins', requireLogin, async (req, res) => {
  try {
    const { amount, price } = req.body; // Masalan, 100 coin uchun 5$
    
    // Bu yerda haqiqiy to'lov gateway (Stripe) chaqiriladi
    // Simulyatsiya: balansdan ayirish
    const user = await User.findById(req.session.userId);
    if (user.balance < price) {
      return res.status(400).json({ success: false, message: "Yetarli balans yo'q" });
    }
    user.balance -= price;
    user.coins += amount;
    await user.save();
    
    res.json({ success: true, message: `${amount} coin sotib olindi`, newCoins: user.coins });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Monetizatsiya: Balans to'ldirish (simulyatsiya, haqiqiyda payment gateway)
app.post('/wallet/deposit', requireLogin, async (req, res) => {
  try {
    const { amount } = req.body; // Masalan, 10$
    
    // Haqiqiy to'lov: Stripe.createPaymentIntent va h.k.
    // Simulyatsiya: balans qo'shish
    const user = await User.findById(req.session.userId);
    user.balance += amount;
    await user.save();
    
    res.json({ success: true, message: `${amount}$ to'ldirildi`, newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reklama olish (oddiy reklama, premium uchun maxsus)
app.get('/ads', requireLogin, async (req, res) => {
  try {
    // Simulyatsiya: oddiy reklamalar
    const ads = [
      { id: 1, title: 'Reklama 1', image: '/ads/ad1.jpg', url: 'https://example.com' },
      { id: 2, title: 'Reklama 2', image: '/ads/ad2.jpg', url: 'https://example.com' }
    ];
    
    // Premium foydalanuvchilar uchun kam reklama
    const user = await User.findById(req.session.userId);
    const filteredAds = user.isPremium ? ads.slice(0, 1) : ads;
    
    res.json({ success: true, ads: filteredAds });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Sponsor post uchun taklif qabul qilish (admin tomonidan)
app.post('/posts/:id/sponsor', requireAdmin, async (req, res) => {
  try {
    const { price } = req.body;
    const post = await Post.findByIdAndUpdate(
      req.params.id,
      { isSponsored: true, sponsorPrice: price },
      { new: true }
    );
    
    // Muallifga pul o'tkazish
    const user = await User.findById(post.userId);
    user.balance += price * 0.7; // 70% muallifga
    await user.save();
    
    res.json({ success: true, post });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin statistikasi (monetizatsiya bilan)
app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const postCount = await Post.countDocuments();
    const totalEarnings = await Post.aggregate([{ $group: { _id: null, total: { $sum: '$sponsorPrice' } } }]);
    const premiumUsers = await User.countDocuments({ isPremium: true });
    
    // Eng ko'p obunachiga ega bo'lgan 10 ta foydalanuvchi
    const topUsers = await User.aggregate([
      {
        $project: {
          username: 1,
          fullName: 1,
          profilePic: 1,
          followersCount: { $size: "$followers" }
        }
      },
      { $sort: { followersCount: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      success: true,
      stats: {
        userCount,
        postCount,
        totalEarnings: totalEarnings[0]?.total || 0,
        premiumUsers,
        topUsers
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Barcha foydalanuvchilarni olish
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Barcha postlarni olish
app.get('/admin/posts', requireAdmin, async (req, res) => {
  try {
    const posts = await Post.find()
      .populate('userId', 'username fullName')
      .sort({ createdAt: -1 });
    
    res.json({ success: true, posts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Postni o'chirish
app.delete('/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    await Post.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Post muvaffaqiyatli o'chirildi" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Foydalanuvchini o'chirish
app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    // Foydalanuvchining postlarini ham o'chirish
    await Post.deleteMany({ userId: req.params.id });
    res.json({ success: true, message: "Foydalanuvchi muvaffaqiyatli o'chirildi" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Xato ishlovchisi
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ success: false, message: error.message });
});

// 404 xatosi
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Sahifa topilmadi" });
});

// Postni o'chirish
app.delete('/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post topilmadi' });
    }
    
    // Post egasini tekshirish (agar kerak bo'lsa)
    // if (post.userId.toString() !== req.user.id) {
    //   return res.status(403).json({ success: false, message: 'Ruxsat yo\'q' });
    // }
    
    // Post bilan bog'liq media fayllarni o'chirish
    if (post.media && post.media.length > 0) {
      for (const media of post.media) {
        fs.unlinkSync(path.join(__dirname, 'uploads', media.filename));
      }
    }
    
    // Postni ma'lumotlar bazasidan o'chirish
    await Post.findByIdAndDelete(postId);
    
    res.json({ success: true, message: 'Post muvaffaqiyatli o\'chirildi' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
});

// Postni tahrirlash
app.put('/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    const { content } = req.body;
    
    const post = await Post.findById(postId);
    
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post topilmadi' });
    }
    
    // Post egasini tekshirish (agar kerak bo'lsa)
    // if (post.userId.toString() !== req.user.id) {
    //   return res.status(403).json({ success: false, message: 'Ruxsat yo\'q' });
    // }
    
    // Post kontentini yangilash
    post.content = content;
    await post.save();
    
    res.json({ success: true, message: 'Post muvaffaqiyatli yangilandi', post });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
});

// Serverni ishga tushurish
app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishlamoqda`);
});