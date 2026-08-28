require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Serve static frontend files (index.html, admin.html)
app.use(express.static(__dirname));

// Serve local dress images from C:\Users\IT\dress-rental-backend\image
app.use('/images', express.static(path.join(__dirname, 'image')));

// PostgreSQL Pool Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Multer Storage Configuration for Admin Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'image'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// 1. Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'connected', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Fetch Catalog Route (Dresses + Sizes + Images + 360 Frames)
app.get('/api/catalog', async (req, res) => {
  try {
    const query = `
      SELECT 
        d.id, 
        d.name, 
        d.brand, 
        d.retail_price, 
        d.image_urls,
        d.images_360,
        ARRAY_AGG(DISTINCT i.size) AS sizes
      FROM dresses d
      LEFT JOIN inventory_items i ON d.id = i.dress_id
      GROUP BY d.id;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Availability Check Endpoint
app.get('/api/check-availability', async (req, res) => {
  const { dressId, size, startDate, endDate } = req.query;

  try {
    const query = `
      SELECT item.id 
      FROM inventory_items item
      WHERE item.dress_id = $1 
        AND item.size = $2
        AND item.id NOT IN (
            SELECT item_id 
            FROM rental_bookings 
            WHERE rental_period && daterange($3::date, ($4::date + INTERVAL '2 days')::date, '[)')
              AND status != 'CANCELLED'
        )
      LIMIT 1;
    `;

    const result = await pool.query(query, [dressId, size, startDate, endDate]);

    if (result.rows.length > 0) {
      res.json({ available: true, itemId: result.rows[0].id });
    } else {
      res.json({ available: false, message: 'No units available for selected dates.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Create Booking Endpoint
app.post('/api/create-booking', async (req, res) => {
  const { itemId, startDate, endDate } = req.body;

  try {
    const insertQuery = `
      INSERT INTO rental_bookings (item_id, rental_period, status)
      VALUES ($1, daterange($2::date, ($3::date + INTERVAL '2 days')::date, '[)'), 'CONFIRMED')
      RETURNING id;
    `;

    const result = await pool.query(insertQuery, [itemId, startDate, endDate]);
    res.json({ success: true, bookingId: result.rows[0].id });
  } catch (err) {
    if (err.code === '23P01') {
      return res.status(409).json({ success: false, message: 'Double-booking blocked: Item was just reserved.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Admin: Fetch All Bookings
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const query = `
      SELECT 
        b.id,
        d.name AS dress_name,
        i.size,
        i.sku,
        b.rental_period,
        b.status
      FROM rental_bookings b
      JOIN inventory_items i ON b.item_id = i.id
      JOIN dresses d ON i.dress_id = d.id
      ORDER BY b.created_at DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin: Cancel Booking
app.patch('/api/admin/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE rental_bookings SET status = 'CANCELLED' WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Admin: Upload Dress Image Endpoint
app.post('/api/admin/upload-image', upload.single('dressImage'), async (req, res) => {
  const { dressId, is360 } = req.body;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  const imageUrl = `/images/${req.file.filename}`;

  try {
    const updateQuery = (is360 === 'true')
      ? `UPDATE dresses SET images_360 = array_append(COALESCE(images_360, '{}'), $1) WHERE id = $2;`
      : `UPDATE dresses SET image_urls = array_append(COALESCE(image_urls, '{}'), $1) WHERE id = $2;`;

    await pool.query(updateQuery, [imageUrl, dressId]);

    res.json({ success: true, message: 'Image uploaded successfully!', imageUrl: imageUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
// Admin Endpoint: Create a completely new dress entry with an uploaded cover image
// Admin Endpoint: Create a brand-new dress entry and automatically generate inventory sizes
app.post('/api/admin/create-dress', upload.single('dressImage'), async (req, res) => {
  const { name, brand, retailPrice } = req.body;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Please attach a cover image.' });
  }

  const imageUrl = `/images/${req.file.filename}`;

  try {
    // 1. Insert new dress
    const dressQuery = `
      INSERT INTO dresses (name, brand, retail_price, image_urls)
      VALUES ($1, $2, $3, ARRAY[$4])
      RETURNING id;
    `;
    const dressResult = await pool.query(dressQuery, [
      name, 
      brand || 'Pretty on Repeat', 
      parseFloat(retailPrice) || 300.00, 
      imageUrl
    ]);
    
    const newDressId = dressResult.rows[0].id;

    // 2. Generate default inventory items with explicit ::uuid casting
    const inventoryQuery = `
      INSERT INTO inventory_items (dress_id, size, sku)
      VALUES 
        ($1::uuid, 'S', CONCAT('SKU-', SUBSTRING($1::text, 1, 8), '-S')),
        ($1::uuid, 'M', CONCAT('SKU-', SUBSTRING($1::text, 1, 8), '-M')),
        ($1::uuid, 'L', CONCAT('SKU-', SUBSTRING($1::text, 1, 8), '-L'));
    `;
    await pool.query(inventoryQuery, [newDressId]);

    res.json({ success: true, message: 'New dress created and added as a catalog card!' });
  } catch (err) {
    console.error('Error creating dress:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// Admin Endpoint 1: Remove a specific image URL from a dress
app.post('/api/admin/delete-image', async (req, res) => {
  const { dressId, imageUrl, is360 } = req.body;

  try {
    const updateQuery = (is360 === 'true')
      ? `UPDATE dresses SET images_360 = array_remove(images_360, $1) WHERE id = $2;`
      : `UPDATE dresses SET image_urls = array_remove(image_urls, $1) WHERE id = $2;`;

    await pool.query(updateQuery, [imageUrl, dressId]);
    res.json({ success: true, message: 'Image removed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Endpoint 2: Delete an entire dress catalog card and its inventory
app.delete('/api/admin/dresses/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Delete associated inventory items first to satisfy foreign key constraints
    await pool.query('DELETE FROM inventory_items WHERE dress_id = $1', [id]);
    await pool.query('DELETE FROM dresses WHERE id = $1', [id]);

    res.json({ success: true, message: 'Dress removed from catalog.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});