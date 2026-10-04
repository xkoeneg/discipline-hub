# Discipline Hub

Standalone Android app (React + Vite + Tailwind, wrapped with Capacitor). No website, no server.
Data is saved on the phone (localStorage) and works fully offline.

## Get the APK (no installs needed) — GitHub builds it for you
1. Push this whole folder to your GitHub repo's `main` branch.
2. Open the repo -> **Actions** tab -> wait for "Build Android APK" to turn green (~5-8 min).
3. On your phone open: `https://github.com/<your-username>/<your-repo>/releases/latest`
   and download `discipline-hub.apk`, then tap it to install
   (allow "Install unknown apps" for your browser when Android asks).

## Updating the app later
Change the code -> push to `main` -> wait for the green check -> download the new APK -> install over the old one.
Your data stays, because every build is signed with the same key (`android/app/discipline-hub.keystore`)
and the version number goes up automatically.

## Run on your computer
    npm install
    npm run dev            # preview in browser
    npm run android:sync   # build web app + copy into the Android project
    npm run android:open   # open in Android Studio (needs Android Studio)

## How the challenge works
- First launch has no challenge. Tap **Configure new challenge**: set a title, the number of days (3-365),
  how many re-checks you get, and your daily tasks. Day 1 is the day you start.
- Once a challenge exists, the button becomes **Edit challenge**: change the title, length (not shorter than today)
  and tasks. The re-check number is fixed at creation and can never be raised.
- At the end of each day: all tasks done = complete, otherwise failed (also failed if you never opened the app that day).
- **Delete challenge** (inside Edit challenge -> Danger zone) wipes everything and returns to the start screen.

## Notes
- The signing key + password are committed on purpose so updates always install over each other.
  Keep the repo private if you care; if you ever publish to Play Store, create a new key.
- App id: `com.disciplinehub.app` (capacitor.config.ts).
