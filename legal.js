/* Privacy policy and data deletion text. Used by the app (Settings, Privacy Policy) and by privacy.html, so both always say the same thing.
   Plain words. It describes what the app does; it does not claim legal approval. Privacy and data laws are to be confirmed with the relevant legal bodies, authorities and entities of Namibia. */
window.LEGAL = (function(){
  var C = { app: 'Ashelz Bible App', dev: 'Loren-Ashlyn Van Rensburg', place: 'Windhoek, Namibia', email: 'ashlyn.dekoe1@gmail.com', date: '14 October 2026' };
  var privacy = [
    ['The short version', ['Ashelz Bible App is free. It has no ads, no tracking and no analytics, and it does not sell or share your information. Your name, prayers, notes, journal, favourites, profile picture and settings stay on your own phone. There is no Ashelz account server.']],
    ['Who we are', [C.app + ' is made and run by ' + C.dev + ', ' + C.place + '. Questions about privacy: ' + C.email + '.']],
    ['What stays on your phone', ['The app keeps these things in your phone\'s own storage and nowhere else: your name, your optional sign in details, your prayers, notes and journal, favourite chapters, highlights, reading progress, saved messages of hope, your profile picture, the Bible chapters you have read (so they work again offline), and your settings.', 'We cannot see any of this. If you remove the app, clear its data, or use Settings, Backup & Restore, Start fresh, it is removed from your phone.']],
    ['Sign in with Google (optional)', ['You can sign in with Google if you want your name on this phone. Google handles the sign in under Google\'s own privacy policy. The app receives your name, email address and picture from Google and keeps them on your phone only. You can use the whole app without signing in. While the sign in page is showing, Google\'s sign in button is loaded from Google, so Google can see that request.']],
    ['What is sent when you read', ['To show Bible text, books and pictures, the app asks other services for them. These services can see the request and your internet address, as every website does. The app does not send your name, notes or prayers to them.', 'Bible text: bible-api.com, the open bible-data collection on GitHub and jsDelivr, the Free Use Bible API (bible.helloao.org) and Biblia.com (Faithlife). If you add your own API.Bible key, requests also go to API.Bible, and that key stays on your phone.', 'Videos and thumbnails: YouTube, only when you open a devotion video. YouTube\'s privacy policy applies once you play a video.', 'Book covers: Open Library and Project Gutenberg.', 'Devotions from Ashelz: the app reads a public file from the app\'s own website. Nothing about you is sent.']],
    ['Online Homecell', ['Homecell meetings use Jitsi Meet (meet.jit.si). Your camera and microphone are used only after you tap to join a meeting and your phone asks your permission. Ashelz does not record meetings. Jitsi\'s own privacy policy applies inside the meeting.']],
    ['Posts by the developer', ['The developer can publish her own devotions, pictures and videos to the app\'s website so everyone can read them. Those posts are public. Readers do not post anything. The developer\'s publishing key is kept only on her own device.']],
    ['Permissions the app may ask for', ['Camera and microphone: to join an Online Homecell meeting, and for the developer to record a devotion. Notifications: only if you turn on the daily reminder, which runs on your phone. Photos or files: only when you choose a picture, for example your profile picture. You can say no to any of these and the rest of the app still works.']],
    ['Children', ['The app is a general Bible app. It does not ask anyone for personal information, and it does not know the age of a reader. Parents and guardians are welcome to read along with their children.']],
    ['Your choices', ['You can change your name, remove your profile picture, sign out, turn off the reminder, or delete everything the app keeps on your phone at any time. See "Delete my data" in the app, or the steps below.']],
    ['Changes to this policy', ['If the app changes what it keeps or sends, this page will be updated and the date below will change.']],
    ['Law', ['This policy is written in plain words to describe what the app does. How privacy and data laws apply is to be confirmed with the relevant legal bodies, authorities and entities of Namibia.']],
    ['Contact', [C.dev + ', ' + C.place + '. ' + C.email + '. Last updated ' + C.date + '.']]
  ];
  var del = [
    ['Delete my data', ['Everything the app keeps is on your own phone, so you are in control of it. There is no Ashelz account to delete.']],
    ['In the app', ['Open Settings, then Backup & Restore, then Start fresh. This removes your prayers, notes, favourites, settings and saved chapters from this phone. In Account you can also remove your profile picture and sign out.']],
    ['From the phone', ['Android: Settings, Apps, Ashelz Bible App, Storage, Clear data (or uninstall the app). Browser: clear the site data for this website.']],
    ['Google sign in', ['To stop Google sharing your details with the app, remove the app in your Google Account, under Security, Third party access.']],
    ['Posts and meetings', ['The app does not hold anything about you on a server. If you joined a Homecell meeting, ask the meeting host and Jitsi about anything shown inside that meeting.']],
    ['Questions', ['Write to ' + C.email + '.']]
  ];
  return { C: C, privacy: privacy, del: del };
})();
