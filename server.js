const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname)); // Serve client files if needed

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store active sessions
const sessions = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let browser = null;
    let page = null;
    let streamInterval = null;

    socket.on('start-session', async ({ url, width, height }) => {
        try {
            if (browser) await browser.close();

            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--enable-gpu',
                    '--use-gl=angle',       // Better for Mac/Metal usually
                    '--ignore-gpu-blocklist', // Force GPU
                    '--enable-features=NetworkService',
                    '--window-size=1280,720'
                ],
                defaultViewport: null
            });
            page = await browser.newPage();
            
            // Set a real User Agent to avoid basic bot detection
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            await page.setViewport({ width: width || 1280, height: height || 720 });
            
            // Console logging to debug
            page.on('console', msg => console.log('PAGE LOG:', msg.text()));
            
            // Override WebGL vendor/renderer to spoof a real GPU
            await page.evaluateOnNewDocument(() => {
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) {
                        return 'Intel Open Source Technology Center';
                    }
                    if (parameter === 37446) {
                        return 'Mesa DRI Intel(R) HD Graphics 630 (Kaby Lake GT2)'; // Mock GPU
                    }
                    return getParameter.apply(this, arguments);
                };
            });

            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // Start streaming screenshots
            const startStreaming = () => {
                if (streamInterval) clearInterval(streamInterval);
                streamInterval = setInterval(async () => {
                    if (!page) return;
                    try {
                        const screenshot = await page.screenshot({ encoding: 'base64', type: 'png' });
                        socket.emit('frame', screenshot);
                    } catch (err) {
                        
                    }
                }, 33); 
            };

            startStreaming();
            socket.emit('session-started');

        } catch (error) {
            console.error('Session start error:', error);
            socket.emit('error', 'Failed to start session');
        }
    });

    socket.on('input-event', async (event) => {
        if (!page) return;
        try {
            switch (event.type) {
                case 'click':
                    await page.mouse.click(event.x, event.y);
                    break;
                case 'mousemove':
                    await page.mouse.move(event.x, event.y);
                    break;
                case 'scroll':
                    await page.mouse.wheel({ deltaX: event.deltaX, deltaY: event.deltaY });
                    break;
                case 'zoom':
                     // Using CDP to set page scale factor
                    const client = await page.target().createCDPSession();
                    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: event.scale });
                    break;
                case 'keydown':
                    await page.keyboard.press(event.key);
                    break;
                case 'type':
                    await page.keyboard.type(event.text);
                    break;
            }
        } catch (err) {
            console.error('Input error:', err);
        }
    });

    socket.on('resize', async ({ width, height }) => {
        if (!page) return;
        try {
            console.log(`Resizing viewport to ${width}x${height}`);
            await page.setViewport({ width, height });
        } catch (err) {
            console.error('Resize error:', err);
        }
    });

    socket.on('navigate', async (url) => {
        if (!page) return;
        try {
             await page.goto(url, { waitUntil: 'domcontentloaded' });
        } catch(err) {
            console.error("Navigation error", err);
        }
    });

    socket.on('disconnect', async () => {
        console.log('User disconnected:', socket.id);
        if (streamInterval) clearInterval(streamInterval);
        if (browser) await browser.close();
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Streaming Server running on http://localhost:${PORT}`));
