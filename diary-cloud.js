(() => {
  'use strict';
  const guestKey = 'mur-menu-v1';
  const activeKey = guestKey + '.active';
  const accountKey = id => guestKey + '.account.' + id;
  const publicUrl = 'https://dudnikkurator-hue.github.io/mur-dnevnichok-demo/';
  const projectUrl = 'https://fwmbaaivmjibqacuirml.supabase.co';
  const publicKey = 'sb_publishable_RYEDsprY3s6NxAieojVgaQ_Ils6GYvg';
  const read = key => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  };
  const sessionKey = 'sb-fwmbaaivmjibqacuirml-auth-token';
  const desiredAccount = read(activeKey);
  const active = read(sessionKey)?.user?.id === desiredAccount ? desiredAccount : null;
  const cacheKey = typeof active === 'string' ? accountKey(active) : guestKey;
  window.diaryStorageKey = cacheKey;
  if (!window.supabase) return;

  const client = window.supabase.createClient(projectUrl, publicKey, {
    auth: {storageKey:sessionKey, flowType:'implicit', persistSession:true, autoRefreshToken:true}
  });
  const fields = ['days', 'movement', 'measurements', 'family', 'dishPreferences'];
  const defaultState = () => ({days:{}, movement:{}, measurements:[], family:[], dishPreferences:{}});
  const mealSlots = [
    ['breakfast','08:30'], ['morning-snack','11:00'], ['lunch','13:30'],
    ['afternoon-snack','16:00'], ['dinner','18:30'], ['evening-snack','20:30']
  ];
  const canonical = value => JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
  const same = (a,b) => canonical(a) === canonical(b);
  const validKey = key => !['__proto__','constructor','prototype'].includes(key);

  function entries(data, field) {
    const value = data[field];
    if (field === 'measurements') return Object.fromEntries((value ?? []).map(record => [record.date,record]));
    if (field === 'family') return Object.fromEntries((value ?? []).map(record => [record[0],record]));
    if (field === 'days') {
      return Object.fromEntries(Object.entries(value ?? {}).flatMap(([date, meals]) =>
        Array.isArray(meals) ? meals.flatMap((meal,index) => {
          const slot = mealSlots[index];
          return slot && meal && (meal.dish || meal.time !== slot[1]) ? [[date + '/' + slot[0],meal]] : [];
        }) : []));
    }
    if (field === 'movement') return Object.fromEntries(Object.entries(value ?? {}).filter(([,records]) => records?.length));
    return value ?? {};
  }

  function place(result, field, key, value) {
    if (field === 'days') {
      const [date,slot] = key.split('/');
      const index = mealSlots.findIndex(([id]) => id === slot);
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date) || index < 0) return;
      result.days[date] ??= mealSlots.map(([,time]) => ({time,dish:null,eaten:false,extra:null}));
      result.days[date][index] = value;
    } else if (Array.isArray(result[field])) {
      result[field].push(value);
    } else {
      result[field][key] = value;
    }
  }

  function mergeDiary(base, local, remote, prefer) {
    const result = defaultState();
    const conflicts = [];
    for (const field of fields) {
      const before = entries(base,field), here = entries(local,field), there = entries(remote,field);
      const keys = new Set([...Object.keys(before), ...Object.keys(here), ...Object.keys(there)]);
      for (const key of [...keys].filter(validKey).sort()) {
        const a = Object.hasOwn(here,key) ? here[key] : undefined;
        const b = Object.hasOwn(there,key) ? there[key] : undefined;
        const previous = Object.hasOwn(before,key) ? before[key] : undefined;
        let value = a;
        if (same(a,b)) value = a;
        else if (same(a,previous)) value = b;
        else if (!same(b,previous)) {
          conflicts.push({field,key,local:a,remote:b});
          if (prefer === 'remote') value = b;
        }
        if (value !== undefined) place(result,field,key,value);
      }
    }
    result.measurements.sort((a,b) => a.date - b.date);
    return {result,conflicts};
  }

  let session = null;
  let syncing = false;
  let recovery = false;
  let authBusy = false;
  let pendingConflicts = '';
  let timer;
  const get = id => document.getElementById(id);
  const message = text => { get('cloud-status').textContent = text; };
  const baseKey = cacheKey + '.base';
  const currentData = () => read(cacheKey) ?? defaultState();
  const setStorage = (key, data) => localStorage.setItem(key, JSON.stringify(data));

  async function synchronize(choice = null) {
    if (syncing || !session || recovery || session.user.id !== active || navigator.onLine === false) return;
    syncing = true;
    try {
      const initial = currentData();
      const {data:remote,error} = await client.from('diary_state').select('revision,data').eq('owner_id', active).maybeSingle();
      if (error) throw error;
      const incoming = remote?.data ?? defaultState();
      const base = read(baseKey) ?? defaultState();
      const {result,conflicts} = mergeDiary(base,initial,incoming);
      const fingerprint = JSON.stringify(conflicts);
      if (conflicts.length && (!choice || pendingConflicts !== fingerprint)) {
        pendingConflicts = fingerprint;
        const preview = get('cloud-conflict-preview');
        preview.textContent = JSON.stringify(conflicts, null, 2);
        get('cloud-conflict').hidden = false;
        get('cloud-panel').open = true;
        message('Есть разные версии записей. Сравните их и выберите, какую сохранить.');
        return;
      }
      if (!same(initial,currentData())) { queueSync(); return; }
      const merged = conflicts.length ? mergeDiary(base,initial,incoming,choice).result : result;
      if (!same(merged,incoming)) {
        let response;
        if (remote) {
          response = await client.from('diary_state').update({data:merged,revision:remote.revision+1})
            .eq('owner_id',active).eq('revision',remote.revision).select('revision');
        } else {
          response = await client.from('diary_state').insert({owner_id:active,data:merged}).select('revision');
        }
        if (response.error?.code === '23505' || (!response.error && !response.data?.length)) {
          queueSync();
          return;
        }
        if (response.error) throw response.error;
      }
      if (!same(initial,currentData())) { queueSync(); return; }
      setStorage(baseKey,merged);
      const localProjection = mergeDiary(defaultState(),initial,defaultState()).result;
      if (!same(merged,localProjection)) {
        setStorage(cacheKey,{...initial,...merged});
        location.reload();
        return;
      }
      pendingConflicts = '';
      get('cloud-conflict').hidden = true;
      message('Записи синхронизированы.');
    } catch {
      message('Облако недоступно. Записи сохранены на этом устройстве. Повторим при восстановлении связи.');
    } finally {
      syncing = false;
    }
  }

  function queueSync() {
    clearTimeout(timer);
    timer = setTimeout(() => synchronize(), 500);
  }

  function updateSession(next) {
    session = next;
    const id = session?.user?.id;
    if (active && id && active !== id) {
      localStorage.removeItem(activeKey);
      location.reload();
      return;
    }
    get('cloud-form').hidden = Boolean(id);
    get('cloud-account').hidden = !id;
    get('cloud-enable').hidden = !id || id === active;
    if (recovery) {
      get('cloud-form').hidden = true;
      get('cloud-account').hidden = true;
      get('cloud-recover').hidden = false;
      get('cloud-panel').open = true;
      message('Введите новый пароль.');
      return;
    }
    if (id && id === active) queueSync();
    else if (id) {
      message('Вход выполнен. Включите синхронизацию, когда будете готовы.');
      get('cloud-panel').open = true;
    } else {
      message('Записи сохраняются на этом устройстве.');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const authForm = get('cloud-form');
    const email = get('cloud-email');
    const password = get('cloud-password');
    const setBusy = value => {
      authBusy = value;
      for (const control of authForm.querySelectorAll('button')) control.disabled = value;
    };
    authForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (authBusy) return;
      const action = event.submitter?.value ?? 'sign-in';
      if (!email.reportValidity() || (action !== 'reset' && !password.reportValidity())) return;
      setBusy(true);
      try {
        const address = email.value.trim();
        if (action === 'reset') {
          const {error} = await client.auth.resetPasswordForEmail(address,{redirectTo:publicUrl});
          if (error) throw error;
          message('Если адрес зарегистрирован, Supabase отправит ссылку для смены пароля.');
        } else if (action === 'register') {
          const {error} = await client.auth.signUp({email:address,password:password.value,options:{emailRedirectTo:publicUrl}});
          if (error) throw error;
          message('Проверьте почту и подтвердите регистрацию по ссылке.');
        } else {
          const {error} = await client.auth.signInWithPassword({email:address,password:password.value});
          if (error) throw error;
        }
        password.value = '';
      } catch {
        message('Не удалось выполнить запрос. Проверьте почту, пароль и подключение.');
      } finally {
        setBusy(false);
      }
    });
    get('cloud-enable').addEventListener('click', () => {
      const id = session?.user?.id;
      if (!id) return;
      try {
        const target = accountKey(id);
        const guest = read(guestKey);
        if (!read(target) && guest && confirm('Перенести питание, движение и измерения из этого браузера в личный аккаунт Supabase?')) {
          setStorage(target,guest);
        }
        setStorage(activeKey,id);
        location.reload();
      } catch {
        message('Не удалось включить синхронизацию. Записи остались на устройстве.');
      }
    });
    get('cloud-sign-out').addEventListener('click', async () => {
      const {error} = await client.auth.signOut({scope:'local'});
      if (error) { message('Не удалось выйти из аккаунта.'); return; }
      localStorage.removeItem(activeKey);
      location.reload();
    });
    get('cloud-recover').addEventListener('submit', async event => {
      event.preventDefault();
      const {error} = await client.auth.updateUser({password:get('cloud-new-password').value});
      if (error) { message('Не удалось изменить пароль. Попробуйте снова.'); return; }
      get('cloud-new-password').value = '';
      recovery = false;
      get('cloud-recover').hidden = true;
      updateSession(session);
      message('Пароль обновлён.');
    });
    get('cloud-conflict-local').addEventListener('click', () => synchronize('local'));
    get('cloud-conflict-remote').addEventListener('click', () => synchronize('remote'));
    client.auth.onAuthStateChange((event,next) => {
      if (event === 'PASSWORD_RECOVERY') recovery = true;
      if (event === 'SIGNED_OUT' && active) {
        localStorage.removeItem(activeKey);
        location.reload();
        return;
      }
      updateSession(next);
    });
    window.addEventListener('diary-saved', queueSync);
    window.addEventListener('online', queueSync);
    window.addEventListener('focus', queueSync);
  });
})();
