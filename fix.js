const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'index.html';
const outputFile = process.argv[3] || 'index-fixed.html';

if (!fs.existsSync(inputFile)) {
  console.error('❌ Файлът не е намерен:', inputFile);
  process.exit(1);
}

let html = fs.readFileSync(inputFile, 'utf8');
console.log('📖 Прочетен файл:', inputFile, '(' + html.length + ' символа)');

// ═══════════════════════════════════════════════════════════════
// ПОПРАВКА 1: Опростяване на login inputs (премахване на inline handlers)
// ═══════════════════════════════════════════════════════════════
const newLoginInputs = `<div class="code-inputs" id="codeInputs">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
  <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off">
</div>`;

html = html.replace(
  /<div class="code-inputs" id="codeInputs">[\s\S]*?<\/div>/,
  newLoginInputs
);
console.log('✅ Поправка 1: Login inputs опростени');

// ═══════════════════════════════════════════════════════════════
// ПОПРАВКА 2: Добавяне на централизиран JS за login inputs
// ═══════════════════════════════════════════════════════════════
const loginJsFix = `
// ==================== LOGIN INPUT HANDLING (mobile fix) ====================
function updateLoginBtnState() {
  const code = Array.from(codeInputEls).map(i => i.value).join('');
  loginBtn.disabled = code.length !== 6;
}

codeInputEls.forEach((input, idx) => {
  input.addEventListener('input', (e) => {
    let val = e.target.value.replace(/[^0-9]/g, '').slice(0, 1);
    e.target.value = val;
    e.target.classList.toggle('filled', !!val);
    if (val && idx < codeInputEls.length - 1) {
      codeInputEls[idx + 1].focus();
    }
    updateLoginBtnState();
    if (Array.from(codeInputEls).every(i => i.value.length === 1)) {
      setTimeout(() => {
        if (!loginBtn.disabled) loginForm.dispatchEvent(new Event('submit'));
      }, 150);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && idx > 0) {
      codeInputEls[idx - 1].focus();
      codeInputEls[idx - 1].value = '';
      codeInputEls[idx - 1].classList.remove('filled');
      updateLoginBtnState();
    }
    if (e.key === 'ArrowLeft' && idx > 0) codeInputEls[idx - 1].focus();
    if (e.key === 'ArrowRight' && idx < codeInputEls.length - 1) codeInputEls[idx + 1].focus();
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
    for (let i = 0; i < codeInputEls.length; i++) {
      codeInputEls[i].value = pasted[i] || '';
      codeInputEls[i].classList.toggle('filled', !!codeInputEls[i].value);
    }
    const nextEmpty = Array.from(codeInputEls).findIndex(i => !i.value);
    if (nextEmpty >= 0) codeInputEls[nextEmpty].focus();
    else codeInputEls[codeInputEls.length - 1].focus();
    updateLoginBtnState();
    if (pasted.length === 6 && !loginBtn.disabled) {
      setTimeout(() => loginForm.dispatchEvent(new Event('submit')), 150);
    }
  });

  input.addEventListener('focus', () => {
    setTimeout(() => input.select(), 50);
  });
});

updateLoginBtnState();
`;

const marker = "const codeInputEls = document.querySelectorAll('#codeInputs input');";
if (html.includes(marker)) {
  html = html.replace(marker, marker + loginJsFix);
  console.log('✅ Поправка 2: Login JS добавен');
} else {
  console.warn('⚠️  Не е намерен marker за Поправка 2');
}

// ═══════════════════════════════════════════════════════════════
// ПОПРАВКА 3: Премахване на JS блока СЛЕД </html>
// ═══════════════════════════════════════════════════════════════
const closingHtmlIdx = html.lastIndexOf('</html>');
if (closingHtmlIdx !== -1) {
  const afterClosing = html.slice(closingHtmlIdx + '</html>'.length).trim();
  if (afterClosing.length > 0) {
    // Извличаме JS кода след </html>
    let orphanJs = afterClosing;
    // Премахваме event listener-а за edit-patient от orphan
    // (той ще бъде добавен вътре в модула)
    html = html.slice(0, closingHtmlIdx + '</html>'.length);
    console.log('✅ Поправка 3: Изтрит JS код след </html> (' + afterClosing.length + ' символа)');
  }
}

// ═══════════════════════════════════════════════════════════════
// ПОПРАВКА 4: Добавяне на patient actions JS вътре в модула
// ═══════════════════════════════════════════════════════════════
const patientActionsJs = `
// ==================== PATIENT ACTIONS ====================
document.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.edit-patient');
  if (editBtn) {
    const pat = patients[editBtn.dataset.id];
    if (!pat) return;
    editingPatientId = editBtn.dataset.id;
    $('patientName').value = pat.name || '';
    $('patientEgn').value = pat.egn || '';
    $('patientPhone').value = pat.phone || '';
    $('patientEmail').value = pat.email || '';
    $('patientBirthDate').value = pat.birthDate || '';
    $('patientGender').value = pat.gender || '';
    $('patientAddress').value = pat.address || '';
    $('patientOccupation').value = pat.occupation || '';
    $('patientInsurance').value = pat.insurance || '';
    $('patientComplaint').value = pat.complaint || '';
    $('patientDiagnosis').value = pat.diagnosis || '';
    $('patientAnamnesis').value = pat.anamnesis || '';
    $('patientPrevInjuries').value = pat.prevInjuries || '';
    $('patientMedications').value = pat.medications || '';
    $('patientAllergies').value = pat.allergies || '';
    $('patientContraindications').value = pat.contraindications || '';
    $('patientGoals').value = pat.goals || '';
    $('patientInitialAssessment').value = pat.initialAssessment || '';
    $('patientPhysicalExam').value = pat.physicalExam || '';
    $('patientWorkingDiagnosis').value = pat.workingDiagnosis || '';
    $('patientTreatmentPlan').value = pat.treatmentPlan || '';
    renderPatientKineziCheckboxes();
    $('addPatientBtn').innerHTML = '<i class="fas fa-save"></i> Запази промените';
    document.querySelectorAll('#patientTabs .patient-tab').forEach(x => x.classList.toggle('active', x.dataset.patientTab === 'new'));
    document.querySelectorAll('.patient-pane').forEach(p => p.classList.toggle('active', p.dataset.patientPane === 'new'));
    document.querySelector('#module-patients .card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Редактиране на: ' + pat.name, 'info');
    return;
  }
  const link = e.target.closest('.patient-link');
  if (link) { openPatientProfile(link.dataset.id); return; }
  const arch = e.target.closest('.archive-single');
  if (arch) {
    if (!confirm('Архивирай пациента?')) return;
    try { await update(clinicRef(\`patients/\${arch.dataset.id}\`), { archived: true, archivedAt: Date.now() }); showToast('Архивиран.', 'success'); }
    catch (err) { showToast('Грешка: ' + err.message, 'error'); }
    return;
  }
  const rest = e.target.closest('.restore-patient');
  if (rest) {
    try { await update(clinicRef(\`patients/\${rest.dataset.id}\`), { archived: false }); showToast('Върнат.', 'success'); }
    catch (err) { showToast('Грешка: ' + err.message, 'error'); }
    return;
  }
  const del = e.target.closest('.delete-patient');
  if (del) {
    if (!confirm('Изтрий завинаги?')) return;
    try { await remove(clinicRef(\`patients/\${del.dataset.id}\`)); showToast('Изтрит.', 'success'); }
    catch (err) { showToast('Грешка: ' + err.message, 'error'); }
  }
});

`;

const initMarker = '// ==================== INIT ====================';
if (html.includes(initMarker)) {
  html = html.replace(initMarker, patientActionsJs + initMarker);
  console.log('✅ Поправка 4: Patient actions JS добавен вътре в модула');
} else {
  console.warn('⚠️  Не е намерен INIT marker за Поправка 4');
}

// ═══════════════════════════════════════════════════════════════
// Записване на резултата
// ═══════════════════════════════════════════════════════════════
fs.writeFileSync(outputFile, html, 'utf8');
console.log('');
console.log('🎉 ГОТОВО!');
console.log('📁 Поправен файл:', outputFile);
console.log('📊 Размер:', (html.length / 1024).toFixed(2) + ' KB');
console.log('');
console.log('➡️  Качете', outputFile, 'в Google Play Console');
`;

fs.writeFileSync('fix.js', fixScript, 'utf8');

### Стъпка 2: Пуснете скрипта

Ако имате **Node.js** инсталиран:

```bash
node fix.js index.html index-fixed.html
