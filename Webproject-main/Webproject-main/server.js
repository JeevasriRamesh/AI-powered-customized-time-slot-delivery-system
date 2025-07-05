const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const { MongoClient } = require('mongodb');
const axios = require('axios');
const twilio = require('twilio');

app.use(express.json());
app.use(express.static('.'));

const OPENWEATHER_API_KEY = '4c2487fe52cb700d2a242ada732a2bed';
const TOMTOM_API_KEY = 'aGmxUb0F9AtnaGK3KF86AGQNCTTQbuoA';

const accountSid = 'AC1d1c158f7e4cb136de1792cbc86c986c';
const authToken = '27a456077979733fae88353dc7cc4c9f';
const twilioWhatsApp = 'whatsapp:+14155238886';
const client = twilio(accountSid, authToken);

const url = 'mongodb://127.0.0.1:27017';
const dbName = 'deliveryApp';
let db;

async function startServer() {
    const client = new MongoClient(url);
    try {
        await client.connect();
        console.log('Connected to MongoDB');
        db = client.db(dbName);
    } catch (err) {
        console.error('MongoDB connection error:', err);
    }
}

async function validateAddress(address) {
    try {
        const cleanAddress = address.replace(/['"“”.]+/g, '').trim();
        console.log(`Validating cleaned address: ${cleanAddress}`);

        const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { q: cleanAddress, format: 'json', limit: 1 }
        });
        if (!geoResponse.data[0]) {
            throw new Error('Address not found in Tamil Nadu - check spelling or try a nearby city');
        }

        const { lat, lon } = geoResponse.data[0];
        console.log(`Nominatim found: lat=${lat}, lon=${lon}`);

        const inTamilNadu = lat >= 8 && lat <= 13.5 && lon >= 76 && lon <= 80.5;
        if (!inTamilNadu) {
            throw new Error(`Address outside Tamil Nadu (lat=${lat}, lon=${lon})`);
        }

        return { valid: true, lat, lon };
    } catch (err) {
        console.error('Address validation error for', address, ':', err.message);
        return { valid: false, suggestion: `${err.message}. Examples: "madurai," "kk nagar, chennai," "coimbatore".` };
    }
}

async function getWeather(address) {
    try {
        const cleanAddress = address.replace(/['"“”.]+/g, '').trim();
        console.log(`Fetching weather for: ${cleanAddress}`);
        const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather`, {
            params: { q: cleanAddress, appid: OPENWEATHER_API_KEY, units: 'metric' }
        });
        const weather = response.data.weather[0].main.toLowerCase();
        console.log(`Weather API response for ${cleanAddress}: ${weather}`);
        return { condition: weather, isBad: weather === 'rain' || weather === 'storm' };
    } catch (err) {
        console.error('Weather API error for', address, ':', err.message);
        return { condition: 'unknown', isBad: false };
    }
}

async function getTraffic(address, date, time) {
    try {
        const cleanAddress = address.replace(/['"“”.]+/g, '').trim();
        const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { q: cleanAddress, format: 'json', limit: 1 }
        });
        if (!geoResponse.data[0]) throw new Error('Address not found');
        const { lat, lon } = geoResponse.data[0];

        const trafficResponse = await axios.get(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json`, {
            params: { point: `${lat},${lon}`, key: TOMTOM_API_KEY }
        });
        const flow = trafficResponse.data.flowSegmentData;
        const speed = flow.currentSpeed;
        const freeFlow = flow.freeFlowSpeed;
        const condition = speed < freeFlow * 0.7 ? 'busy' : 'clear';
        console.log(`Traffic for ${cleanAddress} on ${date} ${time}: ${condition} (speed: ${speed} km/h, free: ${freeFlow} km/h)`);
        return { condition, isBad: condition === 'busy' };
    } catch (err) {
        console.error('Traffic API error for', address, ':', err.message);
        return { condition: 'clear', isBad: false };
    }
}

startServer().then(() => {
    app.post('/schedule', async (req, res) => {
        const { address, date, time, userId, phone } = req.body;
        console.log('Received schedule request:', { address, date, time, userId, phone });
        const schedule = { address, date, time, userId, phone, createdAt: new Date() };

        try {
            const [addressCheck, weatherData, trafficData] = await Promise.all([
                validateAddress(address),
                getWeather(address),
                getTraffic(address, date, time)
            ]);

            if (!addressCheck.valid) {
                return res.status(400).json({ message: `Invalid address: ${address}. ${addressCheck.suggestion}` });
            }

            const collection = db.collection('schedules');
            const slotCount = await collection.countDocuments({ date, time });
            console.log(`Slot count for ${date} ${time}: ${slotCount}`);
            if (slotCount >= 3) {
                return res.status(400).json({ message: `Sorry, the ${time} slot on ${date} is full! Pick another time.` });
            }

            console.log(`Weather for ${address} on ${date}: ${weatherData.condition}, isBad: ${weatherData.isBad}`);
            console.log(`Traffic for ${address} on ${date} ${time}: ${trafficData.condition}, isBad: ${trafficData.isBad}`);
            await collection.insertOne(schedule);
            console.log('Schedule saved to MongoDB');

            const weatherMessage = weatherData.isBad ? `Warning: ${weatherData.condition} expected!` : `Weather looks good (${weatherData.condition}).`;
            const trafficMessage = trafficData.isBad ? `Warning: traffic is ${trafficData.condition}!` : `Traffic looks ${trafficData.condition}.`;
            const displayMessage = `Delivery scheduled for ${date} at ${time} to ${address}! Reminder set for ${date}. ${weatherMessage} ${trafficMessage}`;
            const joinInstructions = `\n\nTo receive this message on WhatsApp, send "join eager-include" to +14155238886 one time.`;
            const fullMessage = `${displayMessage}${joinInstructions}`;
            console.log(`Sending response: ${fullMessage}`);

            if (phone) {
                client.messages.create({
                    body: fullMessage,
                    from: twilioWhatsApp,
                    to: `whatsapp:${phone}`
                })
                .then(message => console.log('WhatsApp message sent:', message.sid))
                .catch(err => console.error('WhatsApp error:', err.message));
            }

            res.json({ 
                displayMessage,
                needsReschedule: weatherData.isBad || trafficData.isBad || slotCount >= 3,
                weather: weatherData.condition,
                traffic: trafficData.condition
            });
            io.emit('newSchedule', { address, date, time, userId, phone, message: displayMessage });
        } catch (err) {
            console.error('Error saving to MongoDB:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    app.post('/reschedule', async (req, res) => {
        const { address, date, time, userId, phone } = req.body;
        console.log('Received reschedule request:', { address, date, time, userId, phone });

        try {
            const [addressCheck, weatherData, trafficData] = await Promise.all([
                validateAddress(address),
                getWeather(address),
                getTraffic(address, date, time)
            ]);

            if (!addressCheck.valid) {
                return res.status(400).json({ message: `Invalid address: ${address}. ${addressCheck.suggestion}` });
            }

            const collection = db.collection('schedules');
            const slotCount = await collection.countDocuments({ date, time });
            console.log(`Slot count for ${date} ${time}: ${slotCount}`);
            if (slotCount >= 3) {
                return res.status(400).json({ message: `Sorry, the ${time} slot on ${date} is full! Pick another time.` });
            }

            console.log(`Weather for ${address} on ${date}: ${weatherData.condition}, isBad: ${weatherData.isBad}`);
            console.log(`Traffic for ${address} on ${date} ${time}: ${trafficData.condition}, isBad: ${trafficData.isBad}`);
            const result = await collection.updateOne(
                { userId },
                { $set: { address, date, time, phone, updatedAt: new Date() } }
            );
            console.log('Reschedule result:', result);

            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Schedule not found—cannot reschedule!' });
            }

            const weatherMessage = weatherData.isBad ? `Warning: ${weatherData.condition} expected!` : `Weather looks good (${weatherData.condition}).`;
            const trafficMessage = trafficData.isBad ? `Warning: traffic is ${trafficData.condition}!` : `Traffic looks ${trafficData.condition}.`;
            const displayMessage = `Delivery rescheduled for ${date} at ${time} to ${address}! Reminder updated for ${date}. ${weatherMessage} ${trafficMessage}`;
            const joinInstructions = `\n\nTo receive this message on WhatsApp, send "join eager-include" to +14155238886 one time.`;
            const fullMessage = `${displayMessage}${joinInstructions}`;
            console.log(`Sending reschedule response: ${fullMessage}`);

            if (phone) {
                client.messages.create({
                    body: fullMessage,
                    from: twilioWhatsApp,
                    to: `whatsapp:${phone}`
                })
                .then(message => console.log('WhatsApp message sent:', message.sid))
                .catch(err => console.error('WhatsApp error:', err.message));
            }

            res.json({ 
                displayMessage,
                needsReschedule: weatherData.isBad || trafficData.isBad || slotCount >= 3,
                weather: weatherData.condition,
                traffic: trafficData.condition
            });
            io.emit('newSchedule', { address, date, time, userId, phone, message: displayMessage });
        } catch (err) {
            console.error('Error rescheduling:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

    app.get('/schedules', async (req, res) => {
        try {
            const collection = db.collection('schedules');
            const schedules = await collection.find().toArray();
            console.log('Fetched schedules:', schedules);
            res.json(schedules);
        } catch (err) {
            console.error('Error fetching schedules:', err);
            res.status(500).json({ error: 'Failed to fetch schedules' });
        }
    });

    app.post('/suggest', async (req, res) => {
        const { date, address } = req.body;
        console.log('Received suggest request:', { date, address });
        const timeSlots = ['9 AM - 11 AM', '1 PM - 3 PM', '5 PM - 7 PM'];

        try {
            const addressCheck = await validateAddress(address);
            if (!addressCheck.valid) {
                return res.status(400).json({ message: `Invalid address: ${address}. ${addressCheck.suggestion}` });
            }

            const collection = db.collection('schedules');
            const counts = await Promise.all(timeSlots.map(time => collection.countDocuments({ date, time })));
            console.log(`Slot counts for ${date}: ${counts.join(', ')}`);

            const weatherData = await getWeather(address);
            const trafficPromises = timeSlots.map(time => getTraffic(address, date, time));
            const trafficData = await Promise.all(trafficPromises);

            console.log(`Weather for ${address} on ${date}: ${weatherData.condition}, isBad: ${weatherData.isBad}`);
            timeSlots.forEach((time, i) => console.log(`Traffic for ${time}: ${trafficData[i].condition}, isBad: ${trafficData[i].isBad}`));

            const scores = timeSlots.map((time, i) => {
                const weatherScore = weatherData.isBad ? 20 : 80;
                const trafficScore = trafficData[i].isBad ? 20 : 80;
                const slotScore = (3 - counts[i]) * 20;
                const totalScore = (weatherScore + trafficScore + slotScore) / 2;
                return { time, score: totalScore, weather: weatherData, traffic: trafficData[i] };
            });

            const bestSlot = scores.reduce((best, current) => current.score > best.score ? current : best);
            const suggestedTime = bestSlot.time;

            if (bestSlot.score >= 70) {
                console.log(`AI suggests ${suggestedTime} with score ${bestSlot.score}`);
                return res.json({ suggestedTime });
            } else {
                const warnings = [];
                if (bestSlot.weather.isBad) warnings.push(`Weather: ${bestSlot.weather.condition}`);
                if (bestSlot.traffic.isBad) warnings.push(`Traffic: ${bestSlot.traffic.condition}`);
                const response = {
                    suggestedTime,
                    warning: warnings.length > 0 ? `Warning: ${warnings.join(' and ')}!` : 'All slots are busy!',
                    needsReschedule: bestSlot.weather.isBad || bestSlot.traffic.isBad
                };
                console.log(`AI suggests ${suggestedTime} with warnings: ${JSON.stringify(response)}`);
                return res.json(response);
            }
        } catch (err) {
            console.error('Error suggesting time:', err);
            res.status(500).json({ message: 'Failed to suggest a time slot' });
        }
    });

    http.listen(3000, () => console.log('Server running on http://localhost:3000'));
}).catch(err => console.error('Server start error:', err));