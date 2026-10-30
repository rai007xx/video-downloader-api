const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  jsonResponse(res, 200, {
    status: 'online',
    service: 'StreamSave API',
    version: '1.0.2',
    endpoints: {
      download: 'GET /api/download?url=YOUR_VIDEO_URL',
      proxy: 'GET /api/proxy?url=DIRECT_MEDIA_URL&filename=video.mp4'
    }
  });
});

// Video metadata & direct links endpoint
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return jsonResponse(res, 400, {
      success: false,
      error: 'Missing URL parameter. Usage: /api/download?url=YOUR_URL'
    });
  }

  try {
    new URL(videoUrl);
  } catch (err) {
    return jsonResponse(res, 400, {
      success: false,
      error: 'Please provide a valid video URL.'
    });
  }

  try {
    console.log(`Processing video URL: ${videoUrl}`);

    const output = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0']
    });

    const title = output.title || 'Downloaded Video';
    const thumbnail = output.thumbnail || (output.thumbnails && output.thumbnails[0]?.url) || '';
    const durationSec = output.duration || 0;
    const durationFormatted = formatDuration(durationSec);

    const rawFormats = output.formats || [];
    const links = [];

    const videoFormats = rawFormats.filter(f => f.url && f.vcodec !== 'none');
    videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (videoFormats.length > 0) {
      const hdFormat = videoFormats.find(f => (f.height || 0) >= 720) || videoFormats[0];
      links.push({
        quality: hdFormat.height ? `${hdFormat.height}p HD` : 'High Definition',
        type: 'mp4',
        url: hdFormat.url,
        size: formatBytes(hdFormat.filesize || hdFormat.filesize_approx)
      });

      const sdFormats = videoFormats.filter(f => (f.height || 0) <= 480 && f.height > 0);
      if (sdFormats.length > 0) {
        const sdFormat = sdFormats[0];
        links.push({
          quality: `${sdFormat.height}p SD`,
          type: 'mp4',
          url: sdFormat.url,
          size: formatBytes(sdFormat.filesize || sdFormat.filesize_approx)
        });
      }
    }

    const audioFormats = rawFormats.filter(f => f.url && f.vcodec === 'none' && f.acodec !== 'none');
    audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length > 0) {
      const audioFormat = audioFormats[0];
      links.push({
        quality: 'Audio Only',
        type: 'mp3',
        url: audioFormat.url,
        size: formatBytes(audioFormat.filesize || audioFormat.filesize_approx)
      });
    }

    if (links.length === 0 && output.url) {
      links.push({
        quality: 'Standard Quality',
        type: 'mp4',
        url: output.url,
        size: ''
      });
    }

    return jsonResponse(res, 200, {
      success: true,
      title: title,
      duration: durationFormatted,
      thumbnail: thumbnail,
      uploader: output.uploader || output.channel || '',
      links: links
    });

  } catch (error) {
    console.error('yt-dlp error:', error.message);
    return jsonResponse(res, 500, {
      success: false,
      error: 'Failed to process video. The URL might be private, geo-blocked, or unsupported.'
    });
  }
});

// Download proxy endpoint using Axios stream to correctly pipe binary video data
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: 'Missing target URL' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.youtube.com/'
      },
      maxRedirects: 5
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[""]/g, '')}"`);
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error('Proxy stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to stream video file from remote server.' });
    }
  }
});

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '03:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function jsonResponse(res, statusCode, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).json(data);
}

app.listen(PORT, () => {
  console.log(`StreamSave Backend API running on port ${PORT}`);
});
