const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const http = require('http');
const { OpenAI } = require("openai");
const { Server } = require('socket.io');

require('dotenv').config();

const app = express();
const server = http.createServer(app);



// 1. SOCKET.IO SETUP
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

global.io = io;
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// 2. DATABASE CONNECTION
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// --- AUTHENTICATION ROUTES ---

app.post('/register', async (req, res) => {
  const { username, email, password, full_name, role } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash, full_name, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role",
      [username, email.toLowerCase().trim(), hashedPassword, full_name, role] 
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error("Reg Error:", err.message);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (userResult.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    res.json({ 
      user: { id: user.id, name: user.username, email: user.email, role: user.role } 
    });
  } catch (err) { res.status(500).json({ error: "Login failed" }); }
});


// --- MESSAGING ROUTES (MATCHED TO NEON) ---
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username, full_name, role FROM users ORDER BY username ASC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Fetch error" }); }
});

app.get('/messages/:u1/:u2', async (req, res) => {
  const { u1, u2 } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, sender_id, receiver_id, text AS message_text, created_at 
       FROM messages 
       WHERE ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))
       AND is_deleted = false ORDER BY created_at ASC`, [u1, u2]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "History error" }); }
});

app.post('/messages', async (req, res) => {
  const { sender_id, receiver_id, message_text } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, text, is_deleted, created_at) 
       VALUES ($1, $2, $3, false, NOW()) 
       RETURNING id, sender_id, receiver_id, text AS message_text, created_at`,
      [sender_id, receiver_id, message_text]
    );
    const msg = result.rows[0];
    io.to(receiver_id.toString()).emit('new_message', msg);
    io.to(sender_id.toString()).emit('new_message', msg);
    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: "Send failed" }); }
});

app.post('/messages/ai', async (req, res) => {
  const { sender_id, message_text } = req.body;

  try {
    // 1. Check permissions
    const userCheck = await pool.query("SELECT has_ai_access FROM users WHERE id = $1", [sender_id]);
    if (!userCheck.rows[0]?.has_ai_access) {
      return res.status(403).json({ error: "Feature Reserved." });
    }

    // 2. Save User Prompt
    await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3)",
      [sender_id, AI_BOT_ID, message_text]
    );

    // 3. Get OpenAI Response
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "You are the FieldMessenger AI assistant." }, { role: "user", content: message_text }],
    });
    const aiText = completion.choices[0].message.content;

    // 4. Save & Return AI Response
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, text, is_ai_response, created_at) 
       VALUES ($1, $2, $3, true, NOW()) RETURNING id, sender_id, text AS message_text, created_at`,
      [AI_BOT_ID, sender_id, aiText]
    );

    // 5. Emit to user's socket
    if (global.io) global.io.to(sender_id.toString()).emit('new_message', result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "AI processing failed." });
  }
});

// --- UNIVERSAL POSTING ROUTES ---

// 1. Regular Feed Posts
app.post('/posts', async (req, res) => {
  const { user_id, description, image_url, media_type } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO posts (author_id, description, image_url, media_type, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *",
      [user_id, description, image_url, media_type || 'image']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Post failed: " + err.message });
  }
});

// 2. Stories
app.post('/stories', async (req, res) => {
  const { user_id, image_url, description } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO stories (user_id, media_url, caption, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *",
      [user_id, image_url, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Story failed: " + err.message });
  }
});

// 3. Fundraising / Investment Opportunities
app.post('/investments', async (req, res) => {
  const { user_id, amount, project_name, roi, duration, account_number, account_name, description, image_url } = req.body;
  try {
    // Note: We create a post entry AND an investment record
    const postResult = await pool.query(
      "INSERT INTO posts (author_id, description, image_url, is_investment, created_at) VALUES ($1, $2, $3, true, NOW()) RETURNING id",
      [user_id, description, image_url]
    );
    
    const result = await pool.query(
      `INSERT INTO investments (post_id, user_id, amount, project_name, roi, duration, account_number, account_name, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW()) RETURNING *`,
      [postResult.rows[0].id, user_id, amount, project_name, roi, duration, account_number, account_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Investment listing failed: " + err.message });
  }
});

// --- FEED FETCHING ---

app.get('/posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.username AS author_name,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
        (SELECT COALESCE(SUM(amount), 0) FROM investments WHERE post_id = p.id) AS total_invested
      FROM posts p JOIN users u ON p.author_id = u.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Fetch error" }); }
});

// --- PROFILE & USER POSTS ROUTES ---

app.get('/users/profile/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT id, username, email, full_name, role, created_at FROM users WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error fetching profile" });
  }
});

app.get('/posts/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, description, image_url, created_at 
       FROM posts 
       WHERE author_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error fetching user posts" });
  }
});

// 🟢 3. Update User Profile (Optional, for the "Save" button in Modal)
app.put('/users/profile/:id', async (req, res) => {
  const { id } = req.params;
  const { full_name, bio } = req.body; // Assuming you add a 'bio' column to your users table
  try {
    const result = await pool.query(
      "UPDATE users SET full_name = $1 WHERE id = $2 RETURNING *",
      [full_name, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  socket.on('join', (userId) => { if (userId) socket.join(userId.toString()); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
