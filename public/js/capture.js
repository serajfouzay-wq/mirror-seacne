/* Guest page: name -> camera -> review -> send.
 * URL options (all optional, handy when linking from an RSVP / QR system):
 *   ?event=wedding      which event/screen the photo belongs to
 *   ?name=Sara          prefill the name
 *   ?ref=GUEST-123      your system's guest id (re-taking replaces that guest's photo)
 *   ?skip=1             skip the name step when name is given
 *   ?lang=ar            Arabic UI (RTL)
 *   ?title=...          custom heading
 *   ?redirect=URL       go back to your system after sending (origin must be allowed)
 * When embedded in an <iframe allow="camera">, posts {type:'mosaic:submitted', ...} to the parent. */
(function () {
  'use strict';
  const { params, cleanEvent, api, config } = Mosaic;
  const $ = (id) => document.getElementById(id);

  const EVENT = cleanEvent(params.get('event'));
  const REF = params.get('ref') || null;
  const SIZE = 720; // output photo size (square)

  // ---------------------------------------------------------------- i18n
  const T = {
    en: {
      title: 'Join the photo wall',
      intro: 'Take a quick selfie — it will appear on the big screen and become part of a giant picture made of everyone here.',
      nameLabel: 'Your name', namePh: 'e.g. Sara',
      consent: 'I agree my photo is shown on the event screen.',
      openCamera: 'Open camera', camHint: 'Centre your face in the frame',
      retake: 'Retake', send: 'Send to the wall',
      doneTitle: "You're in!", doneText: 'Look at the big screen — your photo is joining the wall.',
      donePending: 'Thanks! Your photo will appear on the big screen in a moment.',
      again: 'Take another photo',
      camDenied: 'Camera access was blocked. Allow the camera in your browser settings, or pick a photo from your gallery.',
      camNone: 'No camera found. Pick a photo from your gallery instead.',
      camInsecure: 'The camera needs a secure (https) connection. Pick a photo from your gallery instead.',
      sendFail: 'Could not send your photo. Please check your connection and try again.',
    },
    ar: {
      title: 'انضم إلى جدار الصور',
      intro: 'التقط صورة سيلفي سريعة — ستظهر على الشاشة الكبيرة وتصبح جزءاً من صورة عملاقة تجمع كل الحضور.',
      nameLabel: 'اسمك', namePh: 'مثال: سارة',
      consent: 'أوافق على عرض صورتي على شاشة الحفل.',
      openCamera: 'افتح الكاميرا', camHint: 'ضع وجهك في منتصف الإطار',
      retake: 'إعادة', send: 'أرسل إلى الشاشة',
      doneTitle: 'تم بنجاح!', doneText: 'انظر إلى الشاشة الكبيرة — صورتك تنضم الآن.',
      donePending: 'شكراً! ستظهر صورتك على الشاشة الكبيرة خلال لحظات.',
      again: 'التقط صورة أخرى',
      camDenied: 'تم منع الوصول إلى الكاميرا. اسمح بالكاميرا من إعدادات المتصفح أو اختر صورة من المعرض.',
      camNone: 'لم يتم العثور على كاميرا. اختر صورة من المعرض.',
      camInsecure: 'الكاميرا تحتاج اتصالاً آمناً (https). اختر صورة من المعرض.',
      sendFail: 'تعذر إرسال الصورة. تحقق من الاتصال وحاول مرة أخرى.',
    },
  };
  let lang = params.get('lang') === 'ar' ? 'ar' : 'en';
  const t = (k) => T[lang][k] || T.en[k] || k;

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    $('langToggle').textContent = lang === 'ar' ? 'EN' : 'ع';
    if (params.get('title')) $('title').textContent = params.get('title');
  }
  $('langToggle').onclick = () => { lang = lang === 'ar' ? 'en' : 'ar'; applyLang(); };
  applyLang();

  // ---------------------------------------------------------------- steps
  function show(step) {
    ['stepName', 'stepCamera', 'stepReview', 'stepDone'].forEach((s) => $(s).classList.toggle('hidden', s !== step));
  }

  if (params.get('name')) $('name').value = params.get('name').slice(0, 60);
  try { if (!$('name').value) $('name').value = localStorage.getItem('mosaic:name') || ''; } catch (_) {}

  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    try { localStorage.setItem('mosaic:name', $('name').value.trim()); } catch (_) {}
    openCamera();
  });

  // ---------------------------------------------------------------- camera
  let stream = null;
  let facing = 'user';
  const video = $('video');

  function stopCamera() {
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }

  function camError(msg) {
    $('camError').textContent = msg;
    $('camError').classList.remove('hidden');
    $('shutter').disabled = true;
  }

  async function openCamera() {
    show('stepCamera');
    $('camError').classList.add('hidden');
    $('shutter').disabled = true; // enabled once the stream is live
    stopCamera();
    video.srcObject = null;
    if (!window.isSecureContext) return camError(t('camInsecure'));
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camError(t('camNone'));
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      await video.play().catch(() => {});
      $('shutter').disabled = false;
    } catch (err) {
      console.warn(err);
      camError(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? t('camDenied') : t('camNone'));
    }
  }

  $('switchCam').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; openCamera(); };

  // Draws a centred square crop of `src` into the work canvas and returns a JPEG data URL.
  function squareJpeg(src, sw, sh, mirror) {
    const c = $('work');
    c.width = SIZE;
    c.height = SIZE;
    const ctx = c.getContext('2d');
    const side = Math.min(sw, sh);
    ctx.save();
    if (mirror) { ctx.translate(SIZE, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, SIZE, SIZE);
    ctx.restore();
    return c.toDataURL('image/jpeg', 0.86);
  }

  let photoData = null;

  $('shutter').onclick = async () => {
    if (!stream || !video.videoWidth) return;
    $('shutter').disabled = true;
    const cd = $('countdown');
    cd.classList.remove('hidden');
    for (let i = 3; i > 0; i--) {
      cd.textContent = i;
      cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop');
      await new Promise((r) => setTimeout(r, 800));
    }
    cd.classList.add('hidden');
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 300);
    photoData = squareJpeg(video, video.videoWidth, video.videoHeight, facing === 'user');
    review();
  };

  $('fileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => {
      photoData = squareJpeg(img, img.naturalWidth, img.naturalHeight, false);
      URL.revokeObjectURL(u);
      review();
    };
    img.src = u;
  };

  function review() {
    stopCamera();
    $('preview').src = photoData;
    show('stepReview');
  }

  $('retake').onclick = openCamera;
  $('again').onclick = openCamera;

  // ---------------------------------------------------------------- send
  $('send').onclick = async () => {
    show('stepDone');
    $('spinner').classList.remove('hidden');
    $('doneBox').classList.add('hidden');
    $('sendError').classList.add('hidden');
    const name = $('name').value.trim();
    try {
      const { photo } = await api('api/photos', {
        method: 'POST',
        body: { event: EVENT, name, ref: REF, image: photoData },
      });
      $('spinner').classList.add('hidden');
      $('doneBox').classList.remove('hidden');
      $('doneText').textContent = photo.status === 'approved' ? t('doneText') : t('donePending');
      const msg = { type: 'mosaic:submitted', event: EVENT, ref: REF, name, photo };
      if (window.parent !== window) window.parent.postMessage(msg, '*');
      maybeRedirect(photo);
    } catch (err) {
      console.error(err);
      $('spinner').classList.add('hidden');
      $('sendError').textContent = t('sendFail');
      $('sendError').classList.remove('hidden');
      setTimeout(() => { if (photoData) review(); }, 2500);
    }
  };

  async function maybeRedirect(photo) {
    const target = params.get('redirect');
    if (!target) return;
    let u;
    try { u = new URL(target, location.href); } catch (_) { return; }
    const cfg = await config();
    const allowed = u.origin === location.origin || (cfg.redirectOrigins || []).includes(u.origin);
    if (!allowed || !/^https?:$/.test(u.protocol)) return console.warn('redirect origin not allowed:', u.origin);
    u.searchParams.set('mosaic_photo', photo.id);
    setTimeout(() => location.assign(u.href), 2200);
  }

  // Start
  if (params.get('skip') === '1' && $('name').value) {
    $('consent').checked = true;
    openCamera();
  }
})();
