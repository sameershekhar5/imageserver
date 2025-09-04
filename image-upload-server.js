const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

// Get the server host from environment or default to localhost
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';

// Enable CORS for Angular app
app.use(cors({
  origin: '*',
  optionsSuccessStatus: 200
}));


// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'src', 'assets', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('📁 Created uploads directory:', uploadsDir);
}

// Serve static files from uploads directory
app.use('/assets/uploads', express.static(uploadsDir));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 15);
    const extension = path.extname(file.originalname);
    const filename = `blog-image-${timestamp}-${randomId}${extension}`;
    cb(null, filename);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Upload endpoint
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file uploaded' 
      });
    }

    const imageUrl = `http://${SERVER_HOST}:${PORT}/assets/uploads/${req.file.filename}`;
    
    console.log('✅ Image uploaded successfully:', {
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      path: req.file.path,
      url: imageUrl
    });

    res.json({
      success: true,
      url: imageUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to upload image' 
    });
  }
});

// Get all uploaded images
app.get('/api/images', (req, res) => {
  try {
    if (!fs.existsSync(uploadsDir)) {
      return res.json({ images: [] });
    }

    const files = fs.readdirSync(uploadsDir)
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      })
      .map(file => {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          url: `http://${SERVER_HOST}:${PORT}/assets/uploads/${file}`,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created)); // Sort by newest first

    res.json({ images: files });

  } catch (error) {
    console.error('❌ Error reading images:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to read images' 
    });
  }
});

// Delete image endpoint
app.delete('/api/images/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found' 
      });
    }

    fs.unlinkSync(filePath);
    console.log('✅ Image deleted successfully:', filename);

    res.json({ 
      success: true, 
      message: 'Image deleted successfully' 
    });

  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete image' 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Image upload server is running',
    uploadsDir: uploadsDir
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        error: 'File size too large. Maximum size is 5MB.' 
      });
    }
  }
  
  console.error('❌ Server error:', error);
  res.status(500).json({ 
    success: false, 
    error: error.message || 'Internal server error' 
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Image upload server running on http://${SERVER_HOST}:${PORT}`);
  console.log(`📁 Upload directory: ${uploadsDir}`);
  console.log(`🔗 Test health: http://${SERVER_HOST}:${PORT}/api/health`);
  console.log(`🌐 CORS enabled for: ${FRONTEND_URL}`);
});

module.exports = app;
