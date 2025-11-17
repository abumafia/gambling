const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const http = require('http'); // Added missing require
const socketIo = require('socket.io');

const app = express(); // Moved app definition earlier
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'your_jwt_secret_key_change_in_production';

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

// MongoDB ulanish
mongoose.connect('mongodb+srv://refbot:refbot00@gamepaymentbot.ffcsj5v.mongodb.net/gambling?retryWrites=true&w=majority', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('MongoDB ga ulandi');
}).catch(err => {
    console.error('MongoDB ulanish xatosi:', err);
});

// Schema lar
const UserSchema = new mongoose.Schema({
    firstName: String,
    lastName: String,
    phone: String,
    email: { type: String, unique: true },
    password: String,
    selfie: String,
    idFront: String,
    idBack: String,
    balance: { type: Number, default: 0 },
    demoBalance: { type: Number, default: 5000 },
    isVerified: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    promoCode: { type: String, unique: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referralEarnings: { type: Number, default: 0 },
    currentBet: { type: Number, default: 0 }, // Added for aviator tracking
    createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: String, // 'deposit', 'withdrawal', 'game_win', 'game_loss', 'referral_earn'
    amount: Number,
    status: { type: String, default: 'pending' }, // pending, completed, rejected
    description: String,
    createdAt: { type: Date, default: Date.now }
});

const GameSchema = new mongoose.Schema({
    name: String,
    code: { type: String, unique: true },
    description: { type: String, default: '' },
    minBet: { type: Number, default: 1 },
    maxBet: { type: Number, default: 1000 },
    category: { type: String, default: 'other' },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const GameHistorySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
    betAmount: Number,
    winAmount: Number,
    result: String,
    isDemo: Boolean,
    createdAt: { type: Date, default: Date.now }
});

// Model lar
const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const Game = mongoose.model('Game', GameSchema);
const GameHistory = mongoose.model('GameHistory', GameHistorySchema);

// Uploads papkasini yaratish
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer sozlamalari fayl yuklash uchun
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Auth middleware
const authenticateToken = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'Token kerak' });
        }
        
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = await User.findById(decoded.userId);
        if (!req.user) {
            return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
        }
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token yaroqsiz' });
    }
};

// Existing routes...
app.get('/api/games', (req, res) => {
  res.json({ success: true, games: [] }); // Update as needed
});

// New routes for games
app.post('/api/games/chickenroad/play', authenticateToken, async (req, res) => {
  const { betAmount, isDemo, score } = req.body; // Score from frontend
  const multiplier = score / 100; // Example: based on survival distance
  const profit = betAmount * multiplier;
  const balanceField = isDemo ? 'demoBalance' : 'balance';
  
  // Update user balance
  await User.findByIdAndUpdate(req.user._id, { $inc: { [balanceField]: profit } });
  
  // Save game history
  await new GameHistory({
    userId: req.user._id,
    gameId: null, // Or find game ID
    betAmount,
    winAmount: profit > 0 ? betAmount * multiplier : 0,
    result: profit > 0 ? 'win' : 'loss',
    isDemo
  }).save();
  
  // Save transaction
  await new Transaction({
    userId: req.user._id,
    type: profit > 0 ? 'game_win' : 'game_loss',
    amount: profit,
    status: 'completed',
    description: `Chicken Road - Multiplier: ${multiplier.toFixed(2)}x`
  }).save();
  
  res.json({ success: true, profit, multiplier });
});

app.post('/api/games/aviator/bet', authenticateToken, async (req, res) => {
  const { betAmount, isDemo } = req.body;
  const balanceField = isDemo ? 'demoBalance' : 'balance';
  const currentBalance = req.user[balanceField];
  
  if (betAmount > currentBalance) {
    return res.status(400).json({ error: 'Not enough balance' });
  }
  
  // Deduct bet
  await User.findByIdAndUpdate(req.user._id, { 
    $inc: { [balanceField]: -betAmount },
    currentBet: betAmount 
  });
  
  // Emit via socket
  io.emit('aviator:bet', { user: `${req.user.firstName} ${req.user.lastName}`, bet: betAmount });
  res.json({ success: true });
});

app.post('/api/games/aviator/cashout', authenticateToken, async (req, res) => {
  const { multiplier } = req.body;
  const betAmount = req.user.currentBet;
  if (betAmount === 0) {
    return res.status(400).json({ error: 'No active bet' });
  }
  
  const isDemo = req.body.isDemo || false;
  const balanceField = isDemo ? 'demoBalance' : 'balance';
  const profit = betAmount * multiplier - betAmount;
  
  // Update balance and reset currentBet
  await User.findByIdAndUpdate(req.user._id, { 
    $inc: { [balanceField]: betAmount * multiplier },
    currentBet: 0 
  });
  
  // Save history and transaction (similar to chickenroad)
  await new GameHistory({
    userId: req.user._id,
    gameId: null,
    betAmount,
    winAmount: betAmount * multiplier,
    result: 'cashout',
    isDemo
  }).save();
  
  await new Transaction({
    userId: req.user._id,
    type: 'game_win',
    amount: profit,
    status: 'completed',
    description: `Aviator Cashout - ${multiplier.toFixed(2)}x`
  }).save();
  
  res.json({ success: true, profit });
});

app.post('/api/games/baccarat/play', authenticateToken, async (req, res) => {
  const { betAmount, choice, isDemo } = req.body;
  // Generate hands, determine winner
  const playerHand = (Math.floor(Math.random() * 10) + Math.floor(Math.random() * 10)) % 10;
  const bankerHand = (Math.floor(Math.random() * 10) + Math.floor(Math.random() * 10)) % 10;
  const win = (choice === 'player' && playerHand > bankerHand) || 
              (choice === 'banker' && bankerHand > playerHand) || 
              (choice === 'tie' && playerHand === bankerHand);
  const payout = choice === 'tie' ? 8 : 1.95;
  const profit = win ? betAmount * payout : -betAmount;
  const balanceField = isDemo ? 'demoBalance' : 'balance';
  
  await User.findByIdAndUpdate(req.user._id, { $inc: { [balanceField]: profit } });
  
  await new GameHistory({
    userId: req.user._id,
    gameId: null,
    betAmount,
    winAmount: win ? betAmount * payout : 0,
    result: win ? 'win' : 'loss',
    isDemo
  }).save();
  
  await new Transaction({
    userId: req.user._id,
    type: win ? 'game_win' : 'game_loss',
    amount: profit,
    status: 'completed',
    description: `Baccarat - Choice: ${choice}, Player: ${playerHand}, Banker: ${bankerHand}`
  }).save();
  
  res.json({ success: true, playerHand, bankerHand, win, profit });
});

app.post('/api/games/sicbo/play', authenticateToken, async (req, res) => {
  const { betAmount, choice, isDemo } = req.body;
  const d1 = Math.floor(Math.random() * 6) + 1;
  const d2 = Math.floor(Math.random() * 6) + 1;
  const d3 = Math.floor(Math.random() * 6) + 1;
  const total = d1 + d2 + d3;
  const win = (choice === 'big' && total > 10 && total <= 17) || (choice === 'small' && total >= 4 && total < 11);
  const profit = win ? betAmount : -betAmount;
  const balanceField = isDemo ? 'demoBalance' : 'balance';
  
  await User.findByIdAndUpdate(req.user._id, { $inc: { [balanceField]: profit } });
  
  await new GameHistory({
    userId: req.user._id,
    gameId: null,
    betAmount,
    winAmount: win ? betAmount : 0,
    result: win ? 'win' : 'loss',
    isDemo
  }).save();
  
  await new Transaction({
    userId: req.user._id,
    type: win ? 'game_win' : 'game_loss',
    amount: profit,
    status: 'completed',
    description: `Sic Bo - Total: ${total}, Choice: ${choice}`
  }).save();
  
  res.json({ success: true, dice: [d1, d2, d3], total, win, profit });
});

// Create server after routes
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// WebSocket for Aviator real-time
let aviatorRound = { active: false, crashPoint: 0, bets: [], participants: 0 };

io.on('connection', (socket) => {
  socket.on('aviator:join', () => {
    socket.emit('aviator:state', aviatorRound);
  });

  socket.on('aviator:bet', (data) => {
    aviatorRound.bets.push(data);
    aviatorRound.participants++;
    io.emit('aviator:bets-update', { bets: aviatorRound.bets, participants: aviatorRound.participants });
  });
});

// Auto start every 30s - Moved outside connection handler to run once
setInterval(() => {
  if (!aviatorRound.active) {
    aviatorRound.crashPoint = Math.random() * 100 + 1; // Simplified crash gen
    aviatorRound.active = true;
    aviatorRound.multiplier = 1.0;
    io.emit('aviator:start', aviatorRound);
    const interval = setInterval(() => {
      aviatorRound.multiplier += 0.1;
      io.emit('aviator:update', { multiplier: aviatorRound.multiplier });
      if (aviatorRound.multiplier >= aviatorRound.crashPoint) {
        clearInterval(interval);
        io.emit('aviator:crash', { crashPoint: aviatorRound.crashPoint });
        aviatorRound.active = false;
        aviatorRound.bets = [];
        aviatorRound.participants = 0;
      }
    }, 1000);
  }
}, 30000);

// Admin middleware
const adminMiddleware = async (req, res, next) => {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: 'Admin huquqi kerak' });
    }
    next();
};

// YORDAMCHI FUNKSIYALAR

// Game ni ObjectId yoki name yoki code bo'yicha topish
async function findGameByIdOrName(gameIdentifier) {
    if (mongoose.Types.ObjectId.isValid(gameIdentifier)) {
        return await Game.findById(gameIdentifier);
    } else {
        return await Game.findOne({ 
            $or: [
                { name: { $regex: new RegExp(gameIdentifier, 'i') } },
                { code: { $regex: new RegExp(gameIdentifier, 'i') } }
            ],
            isActive: true 
        });
    }
}

// Referral commission qo'shish
async function addReferralCommission(loserUserId, lossAmount) {
    const loser = await User.findById(loserUserId);
    if (loser && loser.referredBy) {
        const referrer = await User.findById(loser.referredBy);
        if (referrer) {
            const commission = lossAmount * 0.05;
            referrer.balance += commission;
            referrer.referralEarnings += commission;
            await referrer.save();

            // Transaction for referrer
            await new Transaction({
                userId: referrer._id,
                type: 'referral_earn',
                amount: commission,
                status: 'completed',
                description: `Referral commission from ${loser.firstName} ${loser.lastName} loss`
            }).save();
        }
    }
}

// Boshlang'ich o'yinlarni yaratish funksiyasi - Updated with 20 games
async function createDefaultGames() {
    try {
        const games = [
            {
                name: 'Dice Roll',
                code: 'dice',
                description: 'Roll the dice and win big!',
                minBet: 1,
                maxBet: 1000,
                category: 'dice',
                isActive: true
            },
            {
                name: 'Coin Flip',
                code: 'coin',
                description: 'Heads or tails? Make your choice!',
                minBet: 1,
                maxBet: 500,
                category: 'coin',
                isActive: true
            },
            {
                name: 'Slot Machine',
                code: 'slots',
                description: 'Spin the reels and win big!',
                minBet: 1,
                maxBet: 1000,
                category: 'slots',
                isActive: true
            },
            {
                name: 'Roulette',
                code: 'roulette',
                description: 'Bet on red, black or green!',
                minBet: 1,
                maxBet: 500,
                category: 'table',
                isActive: true
            },
            {
                name: 'Card Game',
                code: 'cards',
                description: 'Guess high or low card!',
                minBet: 1,
                maxBet: 200,
                category: 'cards',
                isActive: true
            },
            {
                name: 'Spin Wheel',
                code: 'wheel',
                description: 'Spin to win multipliers!',
                minBet: 1,
                maxBet: 100,
                category: 'wheel',
                isActive: true
            },
            {
                name: 'Blackjack',
                code: 'blackjack',
                description: 'Classic 21 card game!',
                minBet: 5,
                maxBet: 500,
                category: 'cards',
                isActive: true
            },
            {
                name: 'Video Poker',
                code: 'poker',
                description: 'Poker hands payouts!',
                minBet: 1,
                maxBet: 100,
                category: 'poker',
                isActive: true
            },
            {
                name: 'Even/Odd',
                code: 'evenodd',
                description: 'Guess if number is even or odd!',
                minBet: 1,
                maxBet: 500,
                category: 'number',
                isActive: true
            },
            {
                name: 'Over/Under',
                code: 'overunder',
                description: 'Bet over or under 50!',
                minBet: 1,
                maxBet: 500,
                category: 'number',
                isActive: true
            },
            {
                name: 'Suit Guess',
                code: 'suit',
                description: 'Guess the card suit!',
                minBet: 1,
                maxBet: 300,
                category: 'cards',
                isActive: true
            },
            {
                name: 'Red/Black',
                code: 'redblack',
                description: 'Predict red or black card!',
                minBet: 1,
                maxBet: 500,
                category: 'cards',
                isActive: true
            },
            {
                name: 'Number Range',
                code: 'range',
                description: 'Guess 1-5 or 6-10!',
                minBet: 1,
                maxBet: 400,
                category: 'number',
                isActive: true
            },
            {
                name: 'Color Wheel',
                code: 'colorwheel',
                description: 'Spin the color wheel!',
                minBet: 1,
                maxBet: 500,
                category: 'wheel',
                isActive: true
            },
            {
                name: 'Crash',
                code: 'crash',
                description: 'Cash out before crash!',
                minBet: 1,
                maxBet: 200,
                category: 'multiplier',
                isActive: true
            },
            {
                name: 'Mines',
                code: 'mines',
                description: 'Avoid the mines!',
                minBet: 1,
                maxBet: 300,
                category: 'mines',
                isActive: true
            },
            {
                name: 'Plinko',
                code: 'plinko',
                description: 'Drop the ball!',
                minBet: 1,
                maxBet: 400,
                category: 'plinko',
                isActive: true
            },
            {
                name: 'Keno',
                code: 'keno',
                description: 'Pick your numbers!',
                minBet: 1,
                maxBet: 500,
                category: 'lottery',
                isActive: true
            },
            {
                name: 'Bingo',
                code: 'bingo',
                description: 'Get bingo!',
                minBet: 1,
                maxBet: 200,
                category: 'lottery',
                isActive: true
            },
            {
                name: 'Lotto',
                code: 'lotto',
                description: 'Match the lotto numbers!',
                minBet: 5,
                maxBet: 100,
                category: 'lottery',
                isActive: true
            }
        ];

        for (const gameData of games) {
            const exists = await Game.findOne({ code: gameData.code });
            if (!exists) {
                await Game.create(gameData);
                console.log(`Game created: ${gameData.name}`);
            }
        }
    } catch (error) {
        console.error('Error creating default games:', error);
    }
}

// Birinchi adminni avtomatik yaratish
async function createFirstAdmin() {
    try {
        const adminCount = await User.countDocuments({ isAdmin: true });
        if (adminCount === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            const adminUser = new User({
                firstName: 'System',
                lastName: 'Admin',
                email: 'admin@luckybet.com',
                password: hashedPassword,
                phone: 'N/A',
                isAdmin: true,
                isVerified: true,
                balance: 0,
                demoBalance: 0
            });
            await adminUser.save();
            console.log('Birinchi admin foydalanuvchi yaratildi: admin@luckybet.com / admin123');
        }
    } catch (error) {
        console.error('First admin creation error:', error);
    }
}

// YANGI O'YINLAR API LARI - Existing ones remain, new ones added to generic

// Slot Machine o'yini
app.post('/api/play/slots', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // Slot natijasini generatsiya qilish
        const symbols = ['🍒', '🍋', '🍊', '🍇', '🔔', '💎'];
        const reel1 = symbols[Math.floor(Math.random() * symbols.length)];
        const reel2 = symbols[Math.floor(Math.random() * symbols.length)];
        const reel3 = symbols[Math.floor(Math.random() * symbols.length)];

        // G'alaba aniqlash - FIXED LOGIC with low payout
        let winAmount = 0;
        let resultMessage = `${reel1} | ${reel2} | ${reel3} - `;

        if (reel1 === reel2 && reel2 === reel3) {
            winAmount = betAmount * 1.9;
            resultMessage += 'Triple match! You won!';
        } else if (reel1 === reel2 || reel2 === reel3 || reel1 === reel3) {
            winAmount = betAmount * 1.5;
            resultMessage += 'Pair match! You won!';
        } else {
            resultMessage += 'No match. You lost.';
        }

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('slots');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Slots: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            reels: [reel1, reel2, reel3]
        });

    } catch (error) {
        console.error('Slot game error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Roulette o'yini - FIXED LOGIC with low payout
app.post('/api/play/roulette', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo, choice } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        if (!choice || !['red', 'black', 'green'].includes(choice)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid choice'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // Roulette natijasini generatsiya qilish
        const numbers = Array.from({length: 37}, (_, i) => i); // 0-36
        const winningNumber = numbers[Math.floor(Math.random() * numbers.length)];

        // Rang aniqlash
        let winningColor = 'green'; // 0
        if (winningNumber !== 0) {
            const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
            winningColor = redNumbers.includes(winningNumber) ? 'red' : 'black';
        }

        // G'alaba aniqlash - FIXED with low payout
        let winAmount = 0;
        let resultMessage = `Number: ${winningNumber} (${winningColor}) - `;

        if (choice === winningColor) {
            if (choice === 'green') {
                winAmount = betAmount * 1.9; // Reduced for low coeff
                resultMessage += 'GREEN HIT! You won!';
            } else {
                winAmount = betAmount * 1.9;
                resultMessage += 'Color match! You won!';
            }
        } else {
            resultMessage += 'Wrong color. You lost.';
        }

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('roulette');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Roulette: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            winningNumber: winningNumber,
            winningColor: winningColor
        });

    } catch (error) {
        console.error('Roulette game error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Card Game (High/Low) - FIXED LOGIC with low payout
app.post('/api/play/cards', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo, choice } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        if (!choice || !['high', 'low'].includes(choice)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid choice'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // Kartalarni generatsiya qilish
        const suits = ['♥', '♦', '♣', '♠'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        
        const cards = [];
        for (let i = 0; i < 3; i++) {
            const suit = suits[Math.floor(Math.random() * suits.length)];
            const value = values[Math.floor(Math.random() * values.length)];
            cards.push({ suit, value });
        }

        // Karta qiymatlarini hisoblash
        const cardValues = cards.map(card => {
            const valueIndex = values.indexOf(card.value);
            return valueIndex + 2; // 2=2, A=14
        });

        // O'rtacha qiymat
        const averageValue = cardValues.reduce((a, b) => a + b, 0) / cardValues.length;

        // G'alaba aniqlash - FIXED with low payout
        let winAmount = 0;
        let resultMessage = `Cards: ${cards.map(card => `${card.value}${card.suit}`).join(' ')} (Avg: ${averageValue.toFixed(1)}) - `;

        const isHigh = averageValue > 7.5;
        if ((choice === 'high' && isHigh) || (choice === 'low' && !isHigh)) {
            winAmount = betAmount * 1.9;
            resultMessage += 'Correct guess! You won!';
        } else {
            resultMessage += 'Wrong guess. You lost.';
        }

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('cards');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Card Game: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            cards: cards,
            averageValue: averageValue
        });

    } catch (error) {
        console.error('Card game error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Spin Wheel o'yini - FIXED with low payout
app.post('/api/play/wheel', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // G'ildirak bo'limlari - Adjusted for low coeff
        const segments = [
            { multiplier: 0, probability: 52 },   // Loss ~52%
            { multiplier: 1.9, probability: 48 }  // Win 1.9x ~48%
        ];

        // Tasodifiy bo'lim tanlash
        let random = Math.random() * 100;
        let selectedSegment = segments[0];

        for (const segment of segments) {
            if (random < segment.probability) {
                selectedSegment = segment;
                break;
            }
            random -= segment.probability;
        }

        const winAmount = betAmount * selectedSegment.multiplier;
        let resultMessage = `${selectedSegment.multiplier}x - ` + (selectedSegment.multiplier > 0 ? 'You won!' : 'You lost!');

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('wheel');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Wheel: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            multiplier: selectedSegment.multiplier
        });

    } catch (error) {
        console.error('Wheel game error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Blackjack o'yini - FIXED with low payout
app.post('/api/play/blackjack', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // Kartalarni generatsiya qilish
        const getRandomCard = () => {
            const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
            return values[Math.floor(Math.random() * values.length)];
        };

        const playerCards = [getRandomCard(), getRandomCard()];
        const dealerCards = [getRandomCard(), getRandomCard()];

        // Karta qiymatlarini hisoblash
        const calculateHandValue = (cards) => {
            let value = 0;
            let aces = 0;

            for (const card of cards) {
                if (card === 'A') {
                    aces++;
                    value += 11;
                } else if (['K', 'Q', 'J'].includes(card)) {
                    value += 10;
                } else {
                    value += parseInt(card);
                }
            }

            // Aces ni optimallashtirish
            while (value > 21 && aces > 0) {
                value -= 10;
                aces--;
            }

            return value;
        };

        const playerValue = calculateHandValue(playerCards);
        const dealerValue = calculateHandValue(dealerCards);

        // Natijani aniqlash - FIXED with low payout
        let winAmount = 0;
        let resultMessage = `Player: ${playerCards.join(' ')} (${playerValue}) vs Dealer: ${dealerCards.join(' ')} (${dealerValue}) - `;

        const playerBlackjack = playerValue === 21 && playerCards.length === 2;
        const dealerBlackjack = dealerValue === 21 && dealerCards.length === 2;

        if (playerBlackjack && !dealerBlackjack) {
            winAmount = betAmount * 1.9;
            resultMessage += 'BLACKJACK! You won!';
        } else if (dealerBlackjack) {
            resultMessage += 'Dealer BLACKJACK! You lost.';
        } else if (playerValue > 21) {
            resultMessage += 'Bust! You lost.';
        } else if (dealerValue > 21) {
            winAmount = betAmount * 1.9;
            resultMessage += 'Dealer bust! You won!';
        } else if (playerValue > dealerValue) {
            winAmount = betAmount * 1.9;
            resultMessage += 'You won!';
        } else if (playerValue < dealerValue) {
            resultMessage += 'Dealer wins! You lost.';
        } else {
            winAmount = betAmount; // Push
            resultMessage += 'Push! Bet returned.';
        }

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('blackjack');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > betAmount ? 'game_win' : (winAmount < betAmount ? 'game_loss' : 'push');
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Blackjack: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            playerCards: playerCards,
            dealerCards: dealerCards,
            playerValue: playerValue,
            dealerValue: dealerValue
        });

    } catch (error) {
        console.error('Blackjack game error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Video Poker o'yini - FIXED with low payout
app.post('/api/play/poker', authenticateToken, async (req, res) => {
    try {
        const { betAmount, isDemo } = req.body;
        const userId = req.user._id;

        // Validatsiya
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid bet amount'
            });
        }

        // Foydalanuvchi ma'lumotlarini olish
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Balansni tekshirish
        const balance = isDemo ? user.demoBalance : user.balance;
        if (betAmount > balance) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance'
            });
        }

        // Poker qo'lini generatsiya qilish
        const suits = ['♥', '♦', '♣', '♠'];
        const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
        
        const hand = [];
        for (let i = 0; i < 5; i++) {
            const suit = suits[Math.floor(Math.random() * suits.length)];
            const value = values[Math.floor(Math.random() * values.length)];
            hand.push({ suit, value });
        }

        // Poker qo'lini tekshirish - FIXED LOGIC with low multipliers
        const evaluatePokerHand = (cards) => {
            // Qiymatlarni guruhlash
            const valueCounts = {};
            const suitCounts = {};
            
            cards.forEach(card => {
                valueCounts[card.value] = (valueCounts[card.value] || 0) + 1;
                suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
            });

            const valueGroups = Object.values(valueCounts).sort((a, b) => b - a);
            const isFlush = Object.keys(suitCounts).length === 1;
            
            // Qiymatlar ketma-ketligini tekshirish
            const valueIndexes = cards.map(card => values.indexOf(card.value)).sort((a, b) => a - b);
            const isStraight = valueIndexes[4] - valueIndexes[0] === 4 && new Set(valueIndexes).size === 5;
            
            // Simple low payout logic
            if (isFlush && isStraight) {
                return { rank: 'Straight Flush', multiplier: 1.9 };
            }
            
            if (valueGroups[0] === 4) return { rank: 'Four of a Kind', multiplier: 1.9 };
            
            if (valueGroups[0] === 3 && valueGroups[1] === 2) return { rank: 'Full House', multiplier: 1.5 };
            
            if (isFlush) return { rank: 'Flush', multiplier: 1.2 };
            
            if (isStraight) return { rank: 'Straight', multiplier: 1.1 };
            
            if (valueGroups[0] === 3) return { rank: 'Three of a Kind', multiplier: 1.9 };
            
            if (valueGroups[0] === 2 && valueGroups[1] === 2) return { rank: 'Two Pair', multiplier: 1.1 };
            
            const highPairs = ['J', 'Q', 'K', 'A'];
            if (valueGroups[0] === 2 && highPairs.includes(Object.keys(valueCounts).find(key => valueCounts[key] === 2))) {
                return { rank: 'Jacks or Better', multiplier: 1.9 };
            }
            
            return { rank: 'No Win', multiplier: 0 };
        };

        const handResult = evaluatePokerHand(hand);
        const winAmount = betAmount * handResult.multiplier;
        let resultMessage = `${handResult.rank} - ` + (handResult.multiplier > 0 ? 'You won!' : 'No payout. You lost.');

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }

        await user.save();

        // GameHistory yozish
        const game = await findGameByIdOrName('poker');
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game ? game._id : null,
            betAmount,
            winAmount,
            result: resultMessage,
            isDemo
        });
        await gameHistory.save();

        // Transaction yozish
        const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
        const transactionAmount = netAmount;
        const transaction = new Transaction({
            userId: user._id,
            type: transactionType,
            amount: transactionAmount,
            status: 'completed',
            description: `Video Poker: ${resultMessage}`
        });
        await transaction.save();

        res.json({
            success: true,
            result: resultMessage,
            winAmount: winAmount,
            netAmount: netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance,
            hand: hand,
            handRank: handResult.rank,
            multiplier: handResult.multiplier
        });

    } catch (error) {
        console.error('Video Poker error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Asosiy o'yin (Generic for dice, coin, and new simple games) - Updated with new games and fixed logic
app.post('/api/play/:gameId', authenticateToken, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { betAmount, isDemo, choice } = req.body;
        
        if (!betAmount || betAmount <= 0) {
            return res.status(400).json({ error: 'Noto\'g\'ri stavka miqdori' });
        }

        const user = await User.findById(req.user._id);
        
        // Game ni topish
        const game = await findGameByIdOrName(gameId);
        if (!game) {
            return res.status(404).json({ error: 'O\'yin topilmadi' });
        }

        // Balansni tekshirish
        const balanceToCheck = isDemo ? user.demoBalance : user.balance;
        if (balanceToCheck < betAmount) {
            return res.status(400).json({ error: 'Balans yetarli emas' });
        }

        // O'yin logikasi - FIXED with 1.9x payout and correct win/loss
        let winAmount = 0;
        let result = '';

        switch(game.name) {
            case 'Dice Roll':
                const diceResult = Math.floor(Math.random() * 6) + 1;
                const userDiceChoice = parseInt(choice); // 1 low (1-3), 2 high (4-6)
                const isDiceWin = (userDiceChoice === 1 && diceResult <= 3) || (userDiceChoice === 2 && diceResult >= 4);
                winAmount = isDiceWin ? betAmount * 1.9 : 0;
                result = isDiceWin ? `Dice: ${diceResult} - You won!` : `Dice: ${diceResult} - You lost.`;
                break;
                
            case 'Coin Flip':
                const coinResult = Math.random() > 0.5 ? 'heads' : 'tails';
                const isCoinWin = choice === coinResult;
                winAmount = isCoinWin ? betAmount * 1.9 : 0;
                result = isCoinWin ? `Coin: ${coinResult} - You won!` : `Coin: ${coinResult} - You lost.`;
                break;
            case 'Even/Odd':
                const evenOddNum = Math.floor(Math.random() * 10) + 1;
                const isEvenWin = (choice === 'even' && evenOddNum % 2 === 0) || (choice === 'odd' && evenOddNum % 2 !== 0);
                winAmount = isEvenWin ? betAmount * 1.9 : 0;
                result = isEvenWin ? `Number: ${evenOddNum} - You won!` : `Number: ${evenOddNum} - You lost.`;
                break;
            case 'Over/Under':
                const overUnderNum = Math.floor(Math.random() * 100) + 1;
                const isOverWin = (choice === 'over' && overUnderNum > 50) || (choice === 'under' && overUnderNum <= 50);
                winAmount = isOverWin ? betAmount * 1.9 : 0;
                result = isOverWin ? `Number: ${overUnderNum} - You won!` : `Number: ${overUnderNum} - You lost.`;
                break;
            case 'Suit Guess':
                const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
                const suitResult = suits[Math.floor(Math.random() * suits.length)];
                const isSuitWin = choice === suitResult;
                winAmount = isSuitWin ? betAmount * 1.9 : 0;
                result = isSuitWin ? `Suit: ${suitResult} - You won!` : `Suit: ${suitResult} - You lost.`;
                break;
            case 'Red/Black':
                const redBlackResult = Math.random() > 0.5 ? 'red' : 'black';
                const isRedBlackWin = choice === redBlackResult;
                winAmount = isRedBlackWin ? betAmount * 1.9 : 0;
                result = isRedBlackWin ? `Color: ${redBlackResult} - You won!` : `Color: ${redBlackResult} - You lost.`;
                break;
            case 'Number Range':
                const rangeNum = Math.floor(Math.random() * 10) + 1;
                const isRangeWin = (choice === 'low' && rangeNum <= 5) || (choice === 'high' && rangeNum > 5);
                winAmount = isRangeWin ? betAmount * 1.9 : 0;
                result = isRangeWin ? `Number: ${rangeNum} - You won!` : `Number: ${rangeNum} - You lost.`;
                break;
            case 'Color Wheel':
                const colors = ['red', 'blue', 'green'];
                const colorResult = colors[Math.floor(Math.random() * colors.length)];
                const isColorWin = choice === colorResult;
                winAmount = isColorWin ? betAmount * 1.9 : 0;
                result = isColorWin ? `Color: ${colorResult} - You won!` : `Color: ${colorResult} - You lost.`;
                break;
            case 'Crash':
                const crashMultiplier = Math.random() * 1.9 + 0.1;
                winAmount = betAmount * crashMultiplier;
                result = `Crashed at ${crashMultiplier.toFixed(2)}x - You ${crashMultiplier > 1 ? 'won!' : 'lost!'}`;
                break;
            case 'Mines':
                // Simple: 50% chance
                const isMineSafe = Math.random() > 0.5;
                winAmount = isMineSafe ? betAmount * 1.9 : 0;
                result = isMineSafe ? 'Safe spot! You won!' : 'Mine hit! You lost.';
                break;
            case 'Plinko':
                const plinkoSlots = [0, 1.9, 0, 1.1, 0];
                const plinkoResult = plinkoSlots[Math.floor(Math.random() * plinkoSlots.length)];
                winAmount = betAmount * plinkoResult;
                result = `Landed on ${plinkoResult}x - You ${plinkoResult > 0 ? 'won!' : 'lost!'}`;
                break;
            case 'Keno':
                // Simple match 1/10 chance for win
                const isKenoMatch = Math.random() > 0.9;
                winAmount = isKenoMatch ? betAmount * 1.9 : 0;
                result = isKenoMatch ? 'Numbers matched! You won!' : 'No match. You lost.';
                break;
            case 'Bingo':
                const isBingo = Math.random() > 0.5;
                winAmount = isBingo ? betAmount * 1.9 : 0;
                result = isBingo ? 'BINGO! You won!' : 'No bingo. You lost.';
                break;
            case 'Lotto':
                const lottoMatch = Math.random() > 0.8;
                winAmount = lottoMatch ? betAmount * 1.9 : 0;
                result = lottoMatch ? 'Lotto match! You won!' : 'No match. You lost.';
                break;
                
            default:
                winAmount = betAmount * (Math.random() > 0.5 ? 1.9 : 0);
                result = winAmount > 0 ? 'You won!' : 'You lost.';
        }

        // Balansni yangilash
        const netAmount = winAmount - betAmount;
        if (isDemo) {
            user.demoBalance += netAmount;
        } else {
            user.balance += netAmount;
            if (netAmount < 0) {
                await addReferralCommission(user._id, Math.abs(netAmount));
            }
        }
        await user.save();

        // O'yin tarixini saqlash
        const gameHistory = new GameHistory({
            userId: user._id,
            gameId: game._id,
            betAmount,
            winAmount,
            result,
            isDemo
        });
        await gameHistory.save();

        // Tranzaksiya yaratish
        if (!isDemo) {
            const transactionType = winAmount > 0 ? 'game_win' : 'game_loss';
            const transactionAmount = netAmount;
            const transaction = new Transaction({
                userId: user._id,
                type: transactionType,
                amount: transactionAmount,
                status: 'completed',
                description: `${game.name}: ${result}`
            });
            await transaction.save();
        }

        res.json({
            success: true,
            result,
            winAmount,
            netAmount,
            newBalance: user.balance,
            newDemoBalance: user.demoBalance
        });

    } catch (error) {
        console.error('Play game error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Promo code generate
app.post('/api/user/generate-promo', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user.promoCode) {
            let code;
            do {
                code = Math.random().toString(36).substring(2, 8).toUpperCase();
            } while (await User.findOne({ promoCode: code }));
            user.promoCode = code;
            await user.save();
            res.json({ success: true, promoCode: code });
        } else {
            res.json({ success: true, promoCode: user.promoCode });
        }
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ESKI API LAR - Register with promo
app.post('/api/register', upload.fields([
    { name: 'selfie', maxCount: 1 },
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 }
]), async (req, res) => {
    try {
        const { firstName, lastName, phone, email, password, promoCode } = req.body;
        
        // Validatsiya
        if (!firstName || !lastName || !phone || !email || !password) {
            return res.status(400).json({ error: 'Barcha maydonlarni to\'ldiring' });
        }

        // Email tekshirish
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Bu email allaqachon ro\'yxatdan o\'tgan' });
        }

        // Fayllarni tekshirish
        if (!req.files?.selfie || !req.files?.idFront || !req.files?.idBack) {
            return res.status(400).json({ error: 'Barcha rasm fayllarini yuklang' });
        }

        // Promo code tekshirish
        let referredBy = null;
        if (promoCode) {
            const referrer = await User.findOne({ promoCode: promoCode.toUpperCase() });
            if (referrer) {
                referredBy = referrer._id;
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Yangi foydalanuvchi
        const user = new User({
            firstName,
            lastName,
            phone,
            email,
            password: hashedPassword,
            selfie: req.files.selfie[0].filename,
            idFront: req.files.idFront[0].filename,
            idBack: req.files.idBack[0].filename,
            referredBy
        });

        await user.save();

        // Token yaratish
        const token = jwt.sign({ userId: user._id }, JWT_SECRET);

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                balance: user.balance,
                demoBalance: user.demoBalance,
                isAdmin: user.isAdmin
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Bu email allaqachon ro\'yxatdan o\'tgan' });
        }
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Change password
app.put('/api/user/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const user = await User.findById(req.user._id);

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        await user.save();

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// User stats
app.get('/api/user/stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const gameHistory = await GameHistory.find({ userId }).populate('gameId', 'name');
        const transactions = await Transaction.find({ userId, type: { $in: ['game_win', 'game_loss'] } });

        const totalGames = gameHistory.length;
        const totalBets = gameHistory.reduce((sum, h) => sum + h.betAmount, 0);
        const totalWins = gameHistory.reduce((sum, h) => sum + h.winAmount, 0);
        const realGames = gameHistory.filter(h => !h.isDemo).length;
        const demoGames = gameHistory.filter(h => h.isDemo).length;
        const favoriteGame = [...gameHistory.reduce((acc, h) => {
            acc[h.gameId?.name || 'Unknown'] = (acc[h.gameId?.name || 'Unknown'] || 0) + 1;
            return acc;
        }, {})].sort((a, b) => b[1] - a[1])[0]?.[0] || 'None';

        const lastWin = transactions.filter(t => t.type === 'game_win').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

        res.json({
            success: true,
            stats: {
                totalGames,
                totalBets,
                totalWins,
                realGames,
                demoGames,
                favoriteGame,
                lastWin: lastWin ? { ...lastWin.toObject(), game: 'Game' } : null
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Update profile
app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { firstName, lastName, phone } = req.body;
        const user = await User.findByIdAndUpdate(
            req.user._id,
            { firstName, lastName, phone },
            { new: true }
        ).select('-password');

        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email va parol kiritishingiz kerak' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Email yoki parol noto\'g\'ri' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Email yoki parol noto\'g\'ri' });
        }

        // Token yaratish
        const token = jwt.sign({ userId: user._id }, JWT_SECRET);

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                balance: user.balance,
                demoBalance: user.demoBalance,
                isAdmin: user.isAdmin,
                promoCode: user.promoCode,
                referralEarnings: user.referralEarnings
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Foydalanuvchi ma'lumotlari
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        res.json({
            success: true,
            user: {
                id: req.user._id,
                firstName: req.user.firstName,
                lastName: req.user.lastName,
                email: req.user.email,
                phone: req.user.phone,
                balance: req.user.balance,
                demoBalance: req.user.demoBalance,
                isAdmin: req.user.isAdmin,
                selfie: req.user.selfie,
                idFront: req.user.idFront,
                idBack: req.user.idBack,
                promoCode: req.user.promoCode,
                referralEarnings: req.user.referralEarnings
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Deposit so'rovi yaratish
app.post('/api/user/deposit-request', authenticateToken, async (req, res) => {
    try {
        const { amount, paymentMethod } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false,
                error: 'Noto\'g\'ri miqdor' 
            });
        }

        if (amount < 10) {
            return res.status(400).json({ 
                success: false,
                error: 'Minimum deposit miqdori $10' 
            });
        }

        if (!paymentMethod) {
            return res.status(400).json({ 
                success: false,
                error: 'To\'lov usulini tanlang' 
            });
        }

        const transaction = new Transaction({
            userId: req.user._id,
            type: 'deposit',
            amount: amount,
            status: 'pending',
            description: `Deposit via ${paymentMethod}`
        });

        await transaction.save();

        res.json({
            success: true,
            message: 'Deposit so\'rovi yuborildi. Admin tasdiqlashini kuting.',
            transaction: {
                id: transaction._id,
                amount: transaction.amount,
                status: transaction.status,
                description: transaction.description,
                createdAt: transaction.createdAt
            }
        });
    } catch (error) {
        console.error('Deposit request error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server xatosi' 
        });
    }
});

// Withdrawal so'rovi yaratish
app.post('/api/user/withdrawal-request', authenticateToken, async (req, res) => {
    try {
        const { amount, walletAddress } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({ 
                success: false,
                error: 'Noto\'g\'ri miqdor' 
            });
        }

        if (amount < 20) {
            return res.status(400).json({ 
                success: false,
                error: 'Minimum withdrawal miqdori $20' 
            });
        }

        if (amount > req.user.balance) {
            return res.status(400).json({ 
                success: false,
                error: 'Balans yetarli emas' 
            });
        }

        if (!walletAddress) {
            return res.status(400).json({ 
                success: false,
                error: 'Wallet manzili kiritishingiz kerak' 
            });
        }

        const transaction = new Transaction({
            userId: req.user._id,
            type: 'withdrawal',
            amount: -amount,
            status: 'pending',
            description: `Withdrawal to ${walletAddress}`
        });

        await transaction.save();

        res.json({
            success: true,
            message: 'Withdrawal so\'rovi yuborildi. Admin tasdiqlashini kuting.',
            transaction: {
                id: transaction._id,
                amount: transaction.amount,
                status: transaction.status,
                description: transaction.description,
                createdAt: transaction.createdAt
            },
            newBalance: req.user.balance
        });
    } catch (error) {
        console.error('Withdrawal request error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server xatosi' 
        });
    }
});

// Foydalanuvchi tranzaksiyalari
app.get('/api/user/transactions', authenticateToken, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.user._id })
            .sort({ createdAt: -1 })
            .limit(50);

        res.json({
            success: true,
            transactions
        });
    } catch (error) {
        console.error('User transactions error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server xatosi' 
        });
    }
});

// Balans ma'lumotlari
app.get('/api/user/balance', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        
        res.json({
            success: true,
            balance: user.balance,
            demoBalance: user.demoBalance
        });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server xatosi' 
        });
    }
});

// Tranzaksiya statistikasi
app.get('/api/user/transaction-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        
        const stats = await Transaction.aggregate([
            { $match: { userId: userId } },
            {
                $group: {
                    _id: '$type',
                    totalAmount: { $sum: '$amount' },
                    count: { $sum: 1 },
                    pendingCount: {
                        $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
                    }
                }
            }
        ]);

        const formattedStats = {
            totalDeposits: 0,
            totalWithdrawals: 0,
            pendingDeposits: 0,
            pendingWithdrawals: 0
        };

        stats.forEach(stat => {
            if (stat._id === 'deposit') {
                formattedStats.totalDeposits = stat.totalAmount;
                formattedStats.pendingDeposits = stat.pendingCount;
            } else if (stat._id === 'withdrawal') {
                formattedStats.totalWithdrawals = Math.abs(stat.totalAmount);
                formattedStats.pendingWithdrawals = stat.pendingCount;
            }
        });

        res.json({
            success: true,
            stats: formattedStats
        });
    } catch (error) {
        console.error('Transaction stats error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Server xatosi' 
        });
    }
});

// O'yinlar ro'yxati
app.get('/api/games', async (req, res) => {
    try {
        const games = await Game.find({ isActive: true });
        res.json({
            success: true,
            games
        });
    } catch (error) {
        console.error('Games error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Tranzaksiya tarixi
app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.user._id })
            .sort({ createdAt: -1 });
        res.json({
            success: true,
            transactions
        });
    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// O'yin tarixi
app.get('/api/game-history', authenticateToken, async (req, res) => {
    try {
        const gameHistory = await GameHistory.find({ userId: req.user._id })
            .populate('gameId', 'name')
            .sort({ createdAt: -1 });
        res.json({
            success: true,
            gameHistory
        });
    } catch (error) {
        console.error('Game history error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// ADMIN API LAR

// Barcha foydalanuvchilar
app.get('/api/admin/users', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json({
            success: true,
            users
        });
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Foydalanuvchi balansini tahrirlash
app.put('/api/admin/users/:userId/balance', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { balance, demoBalance } = req.body;
        
        const updateData = {};
        if (balance !== undefined) updateData.balance = balance;
        if (demoBalance !== undefined) updateData.demoBalance = demoBalance;
        
        const user = await User.findByIdAndUpdate(
            userId, 
            updateData, 
            { new: true }
        ).select('-password');
        
        res.json({
            success: true,
            user
        });
    } catch (error) {
        console.error('Admin balance update error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Tranzaksiyalar
app.get('/api/admin/transactions', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const transactions = await Transaction.find()
            .populate('userId', 'firstName lastName email')
            .sort({ createdAt: -1 });
        res.json({
            success: true,
            transactions
        });
    } catch (error) {
        console.error('Admin transactions error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// O'yin qo'shish
app.post('/api/admin/games', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const { name, code } = req.body;
        
        if (!name || !code) {
            return res.status(400).json({ 
                error: 'Name va code maydonlarini to\'ldiring' 
            });
        }
        
        const game = new Game({
            name,
            code,
            description: req.body.description || '',
            minBet: req.body.minBet || 1,
            maxBet: req.body.maxBet || 1000,
            category: req.body.category || 'other',
            isActive: true
        });
        
        await game.save();
        res.json({
            success: true,
            game
        });
    } catch (error) {
        console.error('Admin add game error:', error);
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Code allaqachon mavjud' });
        }
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// O'yin statusini o'zgartirish
app.put('/api/admin/games/:gameId/status', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { isActive } = req.body;
        
        const game = await Game.findByIdAndUpdate(
            gameId,
            { isActive },
            { new: true }
        );
        
        if (!game) {
            return res.status(404).json({ error: 'O\'yin topilmadi' });
        }
        
        res.json({
            success: true,
            game
        });
    } catch (error) {
        console.error('Admin game status update error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Barcha o'yinlarni olish
app.get('/api/admin/games', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const games = await Game.find().sort({ createdAt: -1 });
        res.json({
            success: true,
            games
        });
    } catch (error) {
        console.error('Admin games error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Tranzaksiya statusini o'zgartirish
app.put('/api/admin/transactions/:transactionId/status', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { status } = req.body;
        
        if (!['pending', 'completed', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Noto\'g\'ri status' });
        }
        
        const transaction = await Transaction.findById(transactionId);
        if (!transaction) {
            return res.status(404).json({ error: 'Tranzaksiya topilmadi' });
        }
        
        const updatedTransaction = await Transaction.findByIdAndUpdate(
            transactionId,
            { status },
            { new: true }
        ).populate('userId', 'firstName lastName email');
        
        // Agar deposit completed bo'lsa, foydalanuvchi balansini yangilash
        if (status === 'completed' && transaction.type === 'deposit' && transaction.amount > 0) {
            await User.findByIdAndUpdate(
                transaction.userId,
                { $inc: { balance: transaction.amount } }
            );
        }
        
        // Agar withdrawal completed bo'lsa, foydalanuvchi balansini kamaytirish
        if (status === 'completed' && transaction.type === 'withdrawal' && transaction.amount < 0) {
            // Balans yetarli ekanligini tekshirish
            const user = await User.findById(transaction.userId);
            if (user.balance < Math.abs(transaction.amount)) {
                return res.status(400).json({ error: 'Foydalanuvchi balansi yetarli emas' });
            }
            
            await User.findByIdAndUpdate(
                transaction.userId,
                { $inc: { balance: transaction.amount } } // amount manfiy
            );
        }
        
        res.json({
            success: true,
            transaction: updatedTransaction
        });
    } catch (error) {
        console.error('Admin transaction status update error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Foydalanuvchini verify qilish
app.put('/api/admin/users/:userId/verify', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { isVerified = true } = req.body;
        
        const user = await User.findByIdAndUpdate(
            userId,
            { isVerified },
            { new: true }
        ).select('-password');
        
        if (!user) {
            return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
        }
        
        res.json({
            success: true,
            user
        });
    } catch (error) {
        console.error('Admin user verify error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Statistika olish
app.get('/api/admin/stats', authenticateToken, adminMiddleware, async (req, res) => {
    try {
        // Foydalanuvchilar statistikasi
        const totalUsers = await User.countDocuments();
        const verifiedUsers = await User.countDocuments({ isVerified: true });
        const adminUsers = await User.countDocuments({ isAdmin: true });
        
        // O'yin statistikasi
        const totalGames = await GameHistory.countDocuments();
        const totalBets = await GameHistory.aggregate([
            { $group: { _id: null, total: { $sum: '$betAmount' } } }
        ]);
        const totalWins = await GameHistory.aggregate([
            { $group: { _id: null, total: { $sum: '$winAmount' } } }
        ]);
        
        // Tranzaksiya statistikasi
        const totalTransactions = await Transaction.countDocuments();
        const pendingTransactions = await Transaction.countDocuments({ status: 'pending' });
        
        // Balans statistikasi
        const totalBalance = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$balance' } } }
        ]);
        const totalDemoBalance = await User.aggregate([
            { $group: { _id: null, total: { $sum: '$demoBalance' } } }
        ]);
        
        const stats = {
            users: {
                total: totalUsers,
                verified: verifiedUsers,
                admins: adminUsers
            },
            games: {
                total: totalGames,
                totalBets: totalBets[0]?.total || 0,
                totalWins: totalWins[0]?.total || 0
            },
            transactions: {
                total: totalTransactions,
                pending: pendingTransactions
            },
            balance: {
                real: totalBalance[0]?.total || 0,
                demo: totalDemoBalance[0]?.total || 0
            }
        };
        
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'Server xatosi' });
    }
});

// Static fayllar
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/register-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register-login.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Static fayllar uchun route
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Serverni ishga tushirish
app.listen(PORT, async () => {
    console.log(`Server ${PORT}-portda ishga tushdi`);
    await createDefaultGames();
    await createFirstAdmin();
});