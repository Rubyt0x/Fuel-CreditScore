const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const connectWithRetry = async () => {
  const options = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4,
    ssl: true,
    tls: true,
    retryWrites: true,
    w: 'majority'
  };

  try {
    const uri = process.env.MONGODB_URI;
    console.log('Raw MONGODB_URI:', uri); // Add this line to see the raw URI
    
    if (!uri) {
      throw new Error('MONGODB_URI is not set in environment variables');
    }
    
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
      throw new Error(`Invalid MongoDB URI format: ${uri}`);
    }
    
    console.log('Attempting to connect to MongoDB...');
    console.log('Connection URI:', uri.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@')); // Hide credentials in logs
    
    await mongoose.connect(uri, options);
    console.log('Connected to MongoDB successfully');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    console.log('Connection details:', {
      uri: process.env.MONGODB_URI ? 'URI is set' : 'URI is not set',
      options: JSON.stringify(options, null, 2)
    });
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

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected successfully');
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
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10,
      allowed_updates: ['message', 'callback_query']
    }
  }
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
  
  // If it's a conflict error, try to restart polling with a delay
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('Polling conflict detected. Restarting polling in 5 seconds...');
    
    // Stop polling
    bot.stopPolling().then(() => {
      // Wait 5 seconds before restarting
      setTimeout(() => {
        console.log('Restarting polling...');
        bot.startPolling({
          interval: 300,
          autoStart: true,
          params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query']
          }
        }).catch(err => {
          console.error('Error restarting polling:', err);
        });
      }, 5000);
    }).catch(err => {
      console.error('Error stopping polling:', err);
    });
  }
});

// Set up bot commands
bot.setMyCommands([
  { command: '/start', description: 'Start using the bot and register in the current group' },
  { command: '/score', description: 'Check your current credit score in this group' },
  { command: '/leaderboard', description: 'View the top 10 credit scores in this group' }
]).catch(error => {
  console.error('Error setting bot commands:', error);
});

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.first_name || msg.from.username;

    // Check if user already exists
    let user = await User.findOne({ 
      telegramId: userId.toString(),
      chatId: chatId.toString()
    });

    if (!user) {
      // Create new user
      user = new User({
        telegramId: userId.toString(),
        chatId: chatId.toString(),
        username: username,
        creditScore: 0
      });
      await user.save();
      await bot.sendMessage(chatId, `👋 Welcome ${username}! You've been registered in the Fuel Credit Score system. Your initial score is 0.`);
    } else {
      await bot.sendMessage(chatId, `👋 Welcome back ${username}! Your current credit score is ${user.creditScore}.`);
    }
  } catch (err) {
    console.error('Error handling /start command:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error processing your request. Please try again later.");
  }
});

// Handle /leaderboard command
bot.onText(/\/leaderboard/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    // Get top 10 users for this chat
    const topUsers = await User.find({ chatId: chatId.toString() })
      .sort({ creditScore: -1 })
      .limit(10);

    if (topUsers.length === 0) {
      await bot.sendMessage(chatId, "📊 No credit scores recorded yet in this group.");
      return;
    }

    // Create leaderboard message
    let leaderboardMessage = "🏆 *Fuel Credit Score Leaderboard* 🏆\n\n";
    topUsers.forEach((user, index) => {
      const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
      leaderboardMessage += `${medal} ${user.username}: ${user.creditScore} points\n`;
    });

    await bot.sendMessage(chatId, leaderboardMessage, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling /leaderboard command:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error fetching the leaderboard. Please try again later.");
  }
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
        } catch (err) {
          console.error('Error updating credit score:', err);
          await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error updating your credit score. Please try again later.");
        }
      }
    } catch (err) {
      console.error('Error handling sticker reaction:', err);
      await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error handling the sticker reaction. Please try again later.");
    }
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
