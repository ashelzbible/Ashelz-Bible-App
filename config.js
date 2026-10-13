/* App settings you can change. For "Sign in with Google", create an OAuth Web client ID at console.cloud.google.com
   (APIs and Services, Credentials), add your app address under Authorized JavaScript origins, and paste the client ID here. */
window.APPCFG = {
  googleClientId: '794802803818-pqcog7358tiqo2a1vb1tiiakdncrgvdk.apps.googleusercontent.com',
  /* the real address of the app; copies running anywhere else show a warning and the Verify check compares with this site */
  officialUrl: 'https://ashelzbible.github.io/Ashelz-Bible-App/',
  /* where the Creator Studio saves posts (the repository the official site is published from) */
  /* Biblia.com (Faithlife) key for the Bible Translations page. It is a public app key, so also set its Application URL in your Biblia.com account to the app address. */
  bibliaKey: 'f1df097baab12b147082ecbae3ff5415',
  publishRepo: 'mrandrecloete-hub/ashelz-bible-app', publishBranch: 'main',
  officialHosts: ['ashelzbible.github.io', 'ashelz-bible-app.netlify.app', 'ashlez.netlify.app']
};
