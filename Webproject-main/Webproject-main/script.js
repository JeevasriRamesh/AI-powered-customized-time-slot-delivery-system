let map = L.map('map').setView([11.1271, 78.6569], 7); 
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

let marker;

function searchAddress(address) {
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`)
        .then(response => response.json())
        .then(data => {
            console.log('Map search response:', data);
            if (data.length > 0) {
                const { lat, lon } = data[0];
                map.setView([lat, lon], 13);
                if (marker) map.removeLayer(marker);
                marker = L.marker([lat, lon]).addTo(map);
                console.log(`Map updated to ${address} at ${lat}, ${lon}`);
            } else {
                console.log(`Address not found: ${address}`);
            }
        });
}

let isSubmitting = false;

function submitSchedule(event) {
    event.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;

    const address = document.getElementById('address').value;
    const date = document.getElementById('date').value;
    const time = document.getElementById('time').value;
    const phone = document.getElementById('phone').value;
    const userId = document.getElementById('userId').value || Math.random().toString(36).substring(2, 11);
    const schedule = { address, date, time, userId, phone };
    console.log('Submitting schedule:', schedule);

    fetch('http://localhost:3000/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(schedule)
    })
    .then(response => {
        if (!response.ok) {
            return response.json().then(err => { throw new Error(err.message || `Server error: ${response.status}`); });
        }
        return response.json();
    })
    .then(data => {
        console.log('Schedule response:', data);
        const confirmation = document.getElementById('confirmation');
        confirmation.textContent = data.needsReschedule ? 'Conditions not met—please reschedule.' : 'Delivery scheduled successfully!';
        if (data.needsReschedule) {
            confirmation.innerHTML += ` <button class="rescheduleBtn" onclick="reschedule('${userId}', '${address}', '${date}', '${time}', '${phone}')">Reschedule</button>`;
        }
        if (data.displayMessage && data.displayMessage.includes('Delivery scheduled') && !data.needsReschedule) {
            document.getElementById('address').value = '';
            document.getElementById('date').value = '';
            document.getElementById('time').value = '';
            document.getElementById('phone').value = '';
            document.getElementById('userId').value = '';
            map.setView([11.1271, 78.6569], 7);
            if (marker) map.removeLayer(marker);
            console.log('Form reset and map returned to Tamil Nadu');
        }
        isSubmitting = false;
    })
    .catch(err => {
        console.error('Fetch error:', err);
        document.getElementById('confirmation').textContent = err.message || 'Error scheduling—try again!';
        isSubmitting = false;
    });
}

function suggestTime() {
    const date = document.getElementById('date').value;
    const address = document.getElementById('address').value;
    console.log('Suggesting time slot for:', { date, address });

    fetch('http://localhost:3000/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, address })
    })
    .then(response => response.json())
    .then(data => {
        console.log('Received suggestion response:', data);
        const timeInput = document.getElementById('time');
        timeInput.value = data.suggestedTime;
        document.getElementById('confirmation').textContent = data.warning ? 
            `${data.suggestedTime} (${data.warning})` : 
            `Suggested time: ${data.suggestedTime}`;
    });
}

function reschedule(userId, address, date, time, phone) {
    document.getElementById('userId').value = userId;
    document.getElementById('address').value = address;
    document.getElementById('date').value = date;
    document.getElementById('time').value = time;
    document.getElementById('phone').value = phone;
    document.getElementById('deliveryForm').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('confirmation').textContent = 'Edit your schedule and submit to reschedule!';
    console.log('Reschedule prep:', { userId, address, date, time, phone });
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('address').addEventListener('change', (e) => {
        console.log('Address changed:', e.target.value);
        searchAddress(e.target.value);
    });
    document.getElementById('deliveryForm').addEventListener('submit', submitSchedule);
    document.getElementById('suggestButton').addEventListener('click', suggestTime);

    const socket = io();
    socket.on('newSchedule', (data) => {
        console.log('Live update received:', data);
        const liveUpdates = document.getElementById('liveUpdates');
        liveUpdates.innerHTML += `<p>New delivery scheduled: ${data.date} at ${data.time} to ${data.address}</p>`;
    });
});