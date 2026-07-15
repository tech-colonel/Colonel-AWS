const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const meetingController = require('../controllers/meetingController');

router.get('/meetings/connection', authenticateToken, meetingController.getConnectionStatus);
router.get('/meetings/drive-recent', authenticateToken, meetingController.getRecentDriveFiles);
router.get('/meetings/upcoming', authenticateToken, meetingController.getUpcomingMeetings);
router.get('/meetings/recent', authenticateToken, meetingController.getRecentMeetings);
router.get('/meetings/calendar', authenticateToken, meetingController.getCalendarMeetings);
router.post('/meetings/event', authenticateToken, meetingController.createCalendarEvent);
router.post('/meetings/fireflies/join', authenticateToken, meetingController.firefliesJoin);
router.post('/meetings/pin', authenticateToken, meetingController.pinMeeting);
router.delete('/meetings/pin/:transcriptId', authenticateToken, meetingController.unpinMeeting);

module.exports = router;
