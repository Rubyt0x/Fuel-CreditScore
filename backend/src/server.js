const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const connectWithRetry = async () => {
  const options = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4,
    ssl: true,
    tls: true,
    tlsAllowInvalidCertificates: true,
    tlsAllowInvalidHostnames: true
  };

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fuel-credit-score', options);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    console.log('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

connectWithRetry();

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected. Attempting to reconnect...');
  connectWithRetry();
});

// User Schema
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  chatId: { type: String, required: true },
  username: { type: String, required: true },
  creditScore: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Create a compound unique index
userSchema.index({ telegramId: 1, chatId: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);

// Drop existing indexes and recreate them
User.collection.dropIndexes().then(() => {
  console.log('Dropped existing indexes');
  User.collection.createIndex({ telegramId: 1, chatId: 1 }, { unique: true });
  console.log('Created new compound index');
}).catch(err => {
  console.error('Error managing indexes:', err);
});

// Sticker credit values
const STICKER_CREDITS = {
  'CAACAgQAAyEFAASg28saAAMGaB32UymgiQTGbVE0BpSniAqLg-kAAnYZAAKd5PFQFEAlUp3q1aM2BA': 20,  // Add 20 points
  'CAACAgQAAyEFAASg28saAAMLaB33YRqT3aY0WJq1j3JujLr_MokAAmwYAALVfPFQvaBMA18SdHI2BA': -20  // Subtract 20 points
};

// Telegram Bot setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Set up bot commands
bot.setMyCommands([
  { command: '/start', description: 'Start using the bot and register in the current group' },
  { command: '/score', description: 'Check your current credit score in this group' },
  { command: '/leaderboard', description: 'View the top 10 credit scores in this group' }
]).catch(error => {
  console.error('Error setting bot commands:', error);
});

// Debug: Log all messages
bot.on('message', (msg) => {
  console.log('Received message:', JSON.stringify(msg, null, 2));
});

// Handle sticker reactions
bot.on('message', async (msg) => {
  if (msg.reply_to_message && msg.sticker) {
    try {
      const stickerId = msg.sticker.file_id;
      const creditChange = STICKER_CREDITS[stickerId];
      
      if (creditChange) {
        const targetUserId = msg.reply_to_message.from.id.toString();
        const targetUsername = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username;
        const senderId = msg.from.id.toString();
        const senderName = msg.from.first_name || msg.from.username;
        const chatId = msg.chat.id.toString();
        
        // Check if target is a bot
        if (msg.reply_to_message.from.is_bot) {
          await bot.sendMessage(msg.chat.id, "🤖 *beep boop* I'm just a bot, I can't receive credit scores! *beep boop*");
          return;
        }

        // Check if user is trying to change their own score
        if (targetUserId === senderId) {
          await bot.sendMessage(msg.chat.id, "🚫 Sorry, you can't change your own credit score! The Party requires impartial evaluation.");
          return;
        }

        try {
          // Try to find existing user first
          let user = await User.findOne({ 
            telegramId: targetUserId,
            chatId: chatId
          });

          if (!user) {
            // Create new user if not found
            user = new User({
              telegramId: targetUserId,
              chatId: chatId,
              username: targetUsername,
              creditScore: creditChange
            });
            await user.save();
          } else {
            // Update existing user's score
            user.creditScore += creditChange;
            await user.save();
          }

          // Create fun messages based on score change
          let message;
          if (creditChange > 0) {
            const positiveMessages = [
              `🎉 ${targetUsername} just gained ${creditChange} social credit points from ${senderName}! They're on their way to becoming a model citizen!`,
              `🌟 ${targetUsername} earned ${creditChange} social credit points from ${senderName}! The Party is pleased with your contribution!`,
              `🏆 ${targetUsername} received ${creditChange} social credit points from ${senderName}! Your loyalty to The Fuel has been noted!`,
              `✨ ${targetUsername} gained ${creditChange} social credit points from ${senderName}! The Party smiles upon you!`
            ];
            message = positiveMessages[Math.floor(Math.random() * positiveMessages.length)];
          } else {
            const negativeMessages = [
              `⚠️ ${targetUsername} lost ${Math.abs(creditChange)} social credit points due to ${senderName}! The Party is disappointed...`,
              `😔 ${targetUsername} had ${Math.abs(creditChange)} social credit points deducted by ${senderName}! Better luck next time!`,
              `📉 ${targetUsername} lost ${Math.abs(creditChange)} social credit points because of ${senderName}! The Party expects better behavior!`,
              `🚫 ${targetUsername} had ${Math.abs(creditChange)} social credit points removed by ${senderName}! This is not the way of The Fuel!`
            ];
            message = negativeMessages[Math.floor(Math.random() * negativeMessages.length)];
          }
          
          message += `\n\nCurrent social credit: ${user.creditScore}`;
          
          // Add emoji based on score
          if (user.creditScore > 100) {
            message += ' 🏅';
          } else if (user.creditScore > 50) {
            message += ' 🥇';
          } else if (user.creditScore > 0) {
            message += ' 🎯';
          } else if (user.creditScore < -50) {
            message += ' ⚠️';
          } else if (user.creditScore < 0) {
            message += ' 😅';
          }
          
          await bot.sendMessage(msg.chat.id, message, {
            reply_to_message_id: msg.message_id,
            parse_mode: 'Markdown'
          });
        } catch (error) {
          console.error('Error processing sticker reaction:', error);
          await bot.sendMessage(msg.chat.id, '😱 Oops! Something went wrong while processing the credit change. The Party is investigating...');
        }
      } else {
        await bot.sendMessage(msg.chat.id, '🤔 Hmm, that sticker doesn\'t affect social credit scores. Try using one of our special stickers!');
      }
    } catch (error) {
      console.error('Error in sticker handler:', error);
      await bot.sendMessage(msg.chat.id, '😱 Oops! Something went wrong while processing the credit change. The Party is investigating...');
    }
  }
});

// Bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const firstName = msg.from.first_name;
  const lastName = msg.from.last_name;

  try {
    // Check if the command is used in a group
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      // Get chat member info to check if user is admin
      const chatMember = await bot.getChatMember(chatId, userId);
      
      // Check if user is an admin or creator
      if (!['administrator', 'creator'].includes(chatMember.status)) {
        bot.sendMessage(chatId, '🚫 Sorry, only group administrators can use this command. The Party requires proper authorization!');
        return;
      }
    }

    let user = await User.findOne({ 
      telegramId: userId,
      chatId: chatId.toString()
    });
    
    if (!user) {
      user = await User.create({
        telegramId: userId,
        chatId: chatId.toString(),
        username,
        firstName,
        lastName,
        creditScore: 0
      });
    }
    
    const welcomeMessages = [
      `🎉 Welcome to The Fuel Social Credit System! Your current score in this group is: ${user.creditScore}`,
      `🌟 Greetings, citizen! You have been registered in The Fuel Social Credit System. Current score: ${user.creditScore}`,
      `🏆 Welcome to the system! Your social credit journey begins here. Current score: ${user.creditScore}`,
      `✨ The Party welcomes you! Your current social credit score is: ${user.creditScore}`
    ];
    
    const message = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
    bot.sendMessage(chatId, message);
  } catch (error) {
    console.error('Error in /start command:', error);
    bot.sendMessage(chatId, '😱 Oops! Something went wrong. The Party\'s servers are experiencing technical difficulties...');
  }
});

bot.onText(/\/score/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const user = await User.findOne({ 
      telegramId: userId,
      chatId: chatId.toString()
    });
    
    if (user) {
      const scoreMessages = [
        `📊 Your current social credit score in this group is: ${user.creditScore}`,
        `🎯 The Party has evaluated your contributions. Current score: ${user.creditScore}`,
        `📈 Your social credit standing in this group: ${user.creditScore}`,
        `💫 The Fuel Social Credit System reports your current score: ${user.creditScore}`
      ];
      
      const message = scoreMessages[Math.floor(Math.random() * scoreMessages.length)];
      bot.sendMessage(chatId, message);
    } else {
      bot.sendMessage(chatId, '❌ You are not registered in this group. Use /start to join The Fuel Social Credit System!');
    }
  } catch (error) {
    console.error('Error in /score command:', error);
    bot.sendMessage(chatId, '😱 Oops! Something went wrong. The Party\'s servers are experiencing technical difficulties...');
  }
});

bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const topUsers = await User.find({ chatId: chatId.toString() })
      .sort({ creditScore: -1 })
      .limit(10);
      
    if (topUsers.length === 0) {
      bot.sendMessage(chatId, '📊 No citizens have been registered in this group yet. Use /start to join The Fuel Social Credit System!');
      return;
    }
    
    let message = '🏆 *Top 10 Social Credit Scores in this group:*\n\n';
    topUsers.forEach((user, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🎯';
      message += `${medal} ${index + 1}. ${user.firstName || user.username}: ${user.creditScore}\n`;
    });
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error in /leaderboard command:', error);
    bot.sendMessage(chatId, '😱 Oops! Something went wrong. The Party\'s servers are experiencing technical difficulties...');
  }
});

// API Routes
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ creditScore: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

app.get('/api/users/:telegramId', async (req, res) => {
  try {
    const user = await User.findOne({ telegramId: req.params.telegramId });
    if (user) {
      res.json(user);
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error fetching user' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 