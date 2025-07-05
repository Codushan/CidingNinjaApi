// server.js

import express from 'express'; // Changed
import cors from 'cors';       // Changed
import puppeteer from 'puppeteer-core'; // Changed
import chromium from '@sparticuz/chromium'; // Changed
import rateLimit from 'express-rate-limit'; // Changed

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
// (Rest of your rateLimit definition is fine)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Reduced limit for Code360
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Cache for storing scraped data temporarily
const cache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes (longer cache for Code360)

// Utility function to clean and parse numbers
function parseNumber(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[^\d]/g, ''); // Removes all non-digit characters
  return parseInt(cleaned) || 0;
}

// Utility function to parse date (simple for now, just returns cleaned string)
function parseDate(text) {
    if (!text) return null;
    // Trim whitespace and remove common prefixes like "Joined on: "
    let cleanedText = text.trim();
    cleanedText = cleanedText.replace(/^(Joined on|Member since):?\s*/i, '').trim();
    return cleanedText;
}

// Function to scrape Code360 profile using Puppeteer
async function scrapeCode360Puppeteer(username) {
    let browser;
    try {
      browser = await puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });

      const page = await browser.newPage();

    // Set realistic user agent and viewport
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // Set additional headers to avoid detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Navigate to profile page
    const profileUrl = `https://www.naukri.com/code360/profile/${username}`;
    console.log(`Attempting to scrape Code360 profile: ${profileUrl}`);

    await page.goto(profileUrl, {
      waitUntil: 'networkidle2', // Waits until network connections are idle
      timeout: 45000 // Increased timeout for potentially slow loading
    });

    // Enhanced Waiting Strategy for main content
    try {
      // Wait for core problem statistics section
      await page.waitForSelector('.problems-solved', { timeout: 20000 });
      console.log('Successfully waited for the main problems-solved container.');

      // Wait for streak container
      await page.waitForSelector('.current-and-longest-text-container', { timeout: 10000 });
      console.log('Successfully waited for streak container.');

      // Wait for XP points (based on provided snippet)
      await page.waitForSelector('.xp-points', { timeout: 5000 }).catch(() => console.warn('XP points selector timed out.'));

    } catch (e) {
      console.warn('Timeout waiting for core containers. Profile data might not be fully loaded or profile not found.');
      if (e.message.includes('timeout')) throw new Error(`Page element not found or timed out: ${e.message}`);
    }

    // Check if profile exists (re-checking after waits, as content might load later)
    const profileExists = await page.evaluate(() => {
      const pageText = document.body.textContent;
      return !pageText.includes('Profile not found') &&
             !pageText.includes('404') &&
             !pageText.includes('User not found');
    });

    if (!profileExists) {
      throw new Error('Code360 profile not found');
    }

    // --- Core Modification: Extract all statistics including streak, expcount, badge ---
    const stats = await page.evaluate(() => {
      const result = {
        totalSolved: '0',
        easySolved: '0',
        moderateSolved: '0',
        hardSolved: '0',
        ninjaSolved: '0',
        currentStreak: '0',
        longestStreak: '0',
        streakFreezeLeft: '0',
        joinedDate: null,
        expcount: '0',
        badge: null,
        pageTitle: document.title,
        url: window.location.href,
        pageContent: document.body.textContent.substring(0, 1000) // For debugging
      };

      // Extract Total Problems Solved
      const totalElement = document.querySelector('.problems-solved .total');
      if (totalElement) {
        const totalText = totalElement.textContent.trim();
        const match = totalText.match(/\d+/);
        if (match) {
          result.totalSolved = match[0];
        }
      } else {
        console.warn('DEBUG (page.evaluate): Total problems solved element not found.');
      }

      // Extract Easy, Moderate, Hard, and Ninja counts
      const difficultyElements = document.querySelectorAll('.difficulty-wise .difficulty');
      if (difficultyElements.length > 0) {
          difficultyElements.forEach(difficultyDiv => {
            const valueElement = difficultyDiv.querySelector('.value');
            const titleElement = difficultyDiv.querySelector('.title');

            if (valueElement && titleElement) {
              const value = valueElement.textContent.trim();
              const title = titleElement.textContent.trim().toLowerCase();

              if (title === 'easy') {
                result.easySolved = value;
              } else if (title === 'moderate') {
                result.moderateSolved = value;
              } else if (title === 'hard') {
                result.hardSolved = value;
              } else if (title === 'ninja') {
                result.ninjaSolved = value;
              }
            }
          });
      } else {
          console.warn('DEBUG (page.evaluate): Difficulty-wise problems elements not found.');
      }

      // --- Extract Current Streak, Longest Streak, and Streak Freeze Left ---
      const streakContainer = document.querySelector('.current-and-longest-text-container');
      if (streakContainer) {
          const currentStreakElement = streakContainer.querySelector('.text-container.ml-8 .day-count-text p');
          if (currentStreakElement) {
              result.currentStreak = currentStreakElement.textContent.trim();
              console.log('DEBUG (page.evaluate) Raw Current Streak Text:', result.currentStreak);
          } else {
              console.warn('DEBUG (page.evaluate): Current streak element not found.');
          }

          const longestStreakElement = streakContainer.querySelector('.text-container:nth-of-type(2) .day-count-text p');
          if (longestStreakElement) {
              result.longestStreak = longestStreakElement.textContent.trim();
              console.log('DEBUG (page.evaluate) Raw Longest Streak Text:', result.longestStreak);
          } else {
              console.warn('DEBUG (page.evaluate): Longest streak element not found.');
          }

          const streakFreezeElement = streakContainer.querySelector('.text-container:nth-of-type(3) .day-count-text p');
          if (streakFreezeElement) {
              result.streakFreezeLeft = streakFreezeElement.textContent.trim();
              console.log('DEBUG (page.evaluate) Raw Streak Freeze Text:', result.streakFreezeLeft);
          } else {
              console.warn('DEBUG (page.evaluate): Streak freeze element not found.');
          }

      } else {
        console.warn('DEBUG (page.evaluate): Current streak main container (.current-and-longest-text-container) not found.');
      }
      // --- END STREAK LOGIC ---

      // --- Extract Joined Date (CRITICAL: NEEDS YOUR HTML SELECTOR) ---
      const joinedDateElement = document.querySelector('.profile-header-meta .member-since-text') ||
                                 document.querySelector('.some-class-for-joined-date-text') ||
                                 document.querySelector('.profile-details-section p.join-date');

      if (joinedDateElement) {
          const rawJoinedDateText = joinedDateElement.textContent.trim();
          result.joinedDate = rawJoinedDateText;
          console.log('DEBUG (page.evaluate) Raw Joined Date Text:', result.joinedDate);
      } else {
          console.warn('DEBUG (page.evaluate): Joined date element not found. Please provide the exact CSS selector for "Joined on" date.');
      }
      // --- END JOINED DATE LOGIC ---

      // --- Extract Experience Points (expcount) ---
      const xpPointsElement = document.querySelector('.xp-points');
      if (xpPointsElement) {
          result.expcount = xpPointsElement.textContent.trim();
          console.log('DEBUG (page.evaluate) Raw XP Points Text:', result.expcount);
      } else {
          console.warn('DEBUG (page.evaluate): XP Points element (.xp-points) not found.');
      }
      // --- END EXP POINTS LOGIC ---

      // --- Extract Badge (CRITICAL: NEEDS YOUR HTML SELECTOR) ---
      const badgeElements = Array.from(document.querySelectorAll('div'));
      const foundBadgeElement = badgeElements.find(div => {
          const text = div.textContent.trim();
          return text.match(/^\d+\s+\w+/) && (text.toLowerCase().includes('achiever') || text.toLowerCase().includes('badge') || text.toLowerCase().includes('rank'));
      });

      if (foundBadgeElement) {
          result.badge = foundBadgeElement.textContent.trim();
          console.log('DEBUG (page.evaluate) Raw Badge Text:', result.badge);
      } else {
          console.warn('DEBUG (page.evaluate): Badge element not found using heuristic. Please provide a more specific selector if possible.');
      }
      // --- END BADGE LOGIC ---

      return result;
    });

    await browser.close();

    return {
      totalSolved: parseNumber(stats.totalSolved),
      easySolved: parseNumber(stats.easySolved),
      moderateSolved: parseNumber(stats.moderateSolved),
      hardSolved: parseNumber(stats.hardSolved),
      ninjaSolved: parseNumber(stats.ninjaSolved),
      currentStreak: parseNumber(stats.currentStreak),
      longestStreak: parseNumber(stats.longestStreak),
      streakFreezeLeft: parseNumber(stats.streakFreezeLeft),
      joinedDate: parseDate(stats.joinedDate),
      expcount: parseNumber(stats.expcount),
      badge: stats.badge,
      pageTitle: stats.pageTitle,
      url: stats.url,
      debug: stats.pageContent
    };

  } catch (error) {
    if (browser) await browser.close();
    console.error('Puppeteer scraping error for Code360:', error);
    throw error;
  }
}

// Main scraping function for Code360
async function scrapeCode360(username) {
  try {
    const stats = await scrapeCode360Puppeteer(username);

    if (stats.totalSolved === 0 && stats.easySolved === 0 && stats.moderateSolved === 0 &&
        stats.hardSolved === 0 && stats.ninjaSolved === 0 && stats.currentStreak === 0 &&
        stats.longestStreak === 0 && stats.streakFreezeLeft === 0 && !stats.joinedDate &&
        stats.expcount === 0 && !stats.badge) {
      console.warn(`No statistics found for Code360 user '${username}'. Profile might be private or selectors need further updating. Check 'debug' field for partial page content.`);
    }

    return stats;

  } catch (error) {
    console.error(`Code360 scraping failed for ${username}: ${error.message}`);
    throw error;
  }
}

// --- Modified: formatCode360Data to prepare for the desired flat structure ---
function formatCode360Data(stats) {
  return {
    totalSolved: stats.totalSolved || 0,
    easySolved: stats.easySolved || 0,
    mediumSolved: stats.moderateSolved || 0,
    hardSolved: stats.hardSolved || 0,
    ninjaSolved: stats.ninjaSolved || 0,
    currentStreak: stats.currentStreak || 0,
    longestStreak: stats.longestStreak || 0,
    streakFreezeLeft: stats.streakFreezeLeft || 0,
    joinedDate: stats.joinedDate || null,
    expcount: stats.expcount || 0,
    badge: stats.badge || null
  };
}

// --- API Routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', platform: 'Code360', timestamp: new Date().toISOString() });
});

app.get('/api/code360/:username', async (req, res) => {
  try {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const cacheKey = `code360_${username}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log(`Returning cached data for Code360 user: ${username}`);
      return res.json(cached.data);
    }

    console.log(`Scraping fresh Code360 data for: ${username}`);

    const rawStats = await scrapeCode360(username);
    const formattedCoreStats = formatCode360Data(rawStats);

    const finalResponse = {
      status: "success",
      message: "retrieved",
      username: username,
      joinedDate: formattedCoreStats.joinedDate,
      totalSolved: formattedCoreStats.totalSolved,
      totalQuestions: 0,
      easySolved: formattedCoreStats.easySolved,
      totalEasy: 0,
      mediumSolved: formattedCoreStats.mediumSolved,
      totalMedium: 0,
      hardSolved: formattedCoreStats.hardSolved,
      totalHard: 0,
      ninjaSolved: formattedCoreStats.ninjaSolved,
      acceptanceRate: 0.0,
      ranking: 0,
      contributionPoints: 0,
      reputation: 0,
      submissionCalendar: {},
      currentStreak: formattedCoreStats.currentStreak,
      longestStreak: formattedCoreStats.longestStreak,
      streakFreezeLeft: formattedCoreStats.streakFreezeLeft,
      expcount: formattedCoreStats.expcount,
      badge: formattedCoreStats.badge,
    };

    cache.set(cacheKey, {
      data: finalResponse,
      timestamp: Date.now()
    });

    res.json(finalResponse);

  } catch (error) {
    console.error('Code360 API error:', error);

    if (error.message.includes('timeout')) {
      return res.status(408).json({ error: 'Request timeout - Code360 profile took too long to load or element not found.' });
    }

    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'Code360 profile not found' });
    }

    res.status(500).json({
      status: "error",
      message: 'Failed to scrape Code360 profile',
      details: error.message
    });
  }
});

// Test specific username endpoint (MODIFIED)
app.get('/api/test/codushan', async (req, res) => {
  try {
    const username = 'Codushan';
    const rawStats = await scrapeCode360(username);
    const formattedCoreStats = formatCode360Data(rawStats);

    const finalResponse = {
      status: "success",
      message: "retrieved (test)",
      username: username,
      joinedDate: formattedCoreStats.joinedDate,
      totalSolved: formattedCoreStats.totalSolved,
      totalQuestions: 0,
      easySolved: formattedCoreStats.easySolved,
      totalEasy: 0,
      mediumSolved: formattedCoreStats.mediumSolved,
      totalMedium: 0,
      hardSolved: formattedCoreStats.hardSolved,
      totalHard: 0,
      ninjaSolved: formattedCoreStats.ninjaSolved,
      acceptanceRate: 0.0,
      stabilityScore: 0,
      ranking: 0,
      contributionPoints: 0,
      reputation: 0,
      submissionCalendar: {},
      currentStreak: formattedCoreStats.currentStreak,
      longestStreak: formattedCoreStats.longestStreak,
      streakFreezeLeft: formattedCoreStats.streakFreezeLeft,
      expcount: formattedCoreStats.expcount,
      badge: formattedCoreStats.badge,
    };

    res.json(finalResponse);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Failed test scrape",
      details: error.message
    });
  }
});

// Clear cache endpoint
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ message: 'Cache cleared successfully' });
});

// Get cache stats
app.get('/api/cache/stats', (req, res) => {
  const stats = {
    size: cache.size,
    entries: Array.from(cache.keys())
  };
  res.json(stats);
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Export the Express app for Vercel (ESM syntax)
export default app; // Changed