/**
 * Padify cloud sync — user interface.
 *
 * Three surfaces, all hidden until the owner configures a sync project:
 *  • a navbar cloud icon with a live status dot,
 *  • a Cloud modal (sign-in / sign-up + account view with sync state),
 *  • a "Cloud sync" section inside Settings pointing at the modal.
 */

import { $ } from '../lib/q';
import { openModal, closeModal } from '../ui/behavior/modal';
import { showToast } from '../ui/toast';
import { getCloudConfig } from './config';
import { getCloudSync, type CloudStatus } from './sync';

const enum DotState {
  OFF = 'off',
  BUSY = 'busy',
  OK = 'ok',
  ERROR = 'error',
}

let mode: 'sign-in' | 'sign-up' = 'sign-in';

export function initCloudUI(): void {
  const sync = getCloudSync();
  const config = getCloudConfig();

  // Unconfigured installs keep every cloud surface hidden — the app is a
  // plain local notepad, exactly as before.
  if (!config) {
    return;
  }

  const $button = $('#cloudNavContainer');
  const $dot = $('#cloudStatusDot');
  const $settingsSection = $('#cloudSettingsSection');
  const $settingsNav = $('#cloudSettingsNav');
  $button.removeAttr('hidden');
  $settingsSection.removeAttr('hidden');
  // The rebuilt settings modal gives the section a nav tab too — reveal it
  // with the pane (see ui/settings-nav.ts; the tablist skips both while
  // hidden).
  $settingsNav.removeAttr('hidden');

  // ---- status rendering -----------------------------------------------------

  const renderStatus = (status: CloudStatus): void => {
    let dot = DotState.OFF;
    let title = 'Cloud sync';

    switch (status.state) {
      case 'unconfigured':
        return;
      case 'signed-out':
        dot = DotState.OFF;
        title = 'Cloud sync — sign in to back up your notes';
        break;
      case 'signed-in':
        switch (status.sync) {
          case 'syncing':
            dot = DotState.BUSY;
            title = 'Cloud sync — syncing…';
            break;
          case 'pending':
            dot = DotState.BUSY;
            title = 'Cloud sync — changes waiting to upload';
            break;
          case 'idle':
            dot = DotState.OK;
            title = status.lastSyncAt
              ? `Cloud sync — up to date (last sync ${formatTime(status.lastSyncAt)})`
              : 'Cloud sync — up to date';
            break;
          case 'offline':
            dot = DotState.ERROR;
            title = 'Cloud sync — offline, will retry automatically';
            break;
        }
        // A stuck note is not an error state — the rest of the queue
        // still syncs — but it must be visible from the navbar, not only
        // inside the modal.
        if (status.warning) {
          title = `Cloud sync — ${status.warning}`;
        }
        break;
      case 'error':
        dot = DotState.ERROR;
        title = `Cloud sync — ${status.message}`;
        break;
    }

    $dot.attr('class', `cloud-status-dot ${dot}`);
    $button.attr('title', title);

    // Modal (both panes) + settings summary reflect the same status.
    renderModal(status);
    renderSettingsSummary(status);
  };

  // ---- navbar ----------------------------------------------------------------

  $button.on('click', () => {
    openCloudModal();
  });

  // ---- modal ------------------------------------------------------------------

  const $submit = $('#cloudAuthSubmit');
  const $switch = $('#cloudAuthSwitch');
  const $error = $('#cloudAuthError');
  const $notice = $('#cloudAuthNotice');
  const $email = $('#cloudAuthEmail');
  const $password = $('#cloudAuthPassword');
  const $pane = $('#cloudAuthPane');
  const $form = $('#cloudAuthForm');

  const setMode = (next: 'sign-in' | 'sign-up'): void => {
    mode = next;
    $error.text('').addClass('hide');
    $notice.text('').addClass('hide');
    $submit.text(next === 'sign-in' ? 'Sign in' : 'Create account');
    $switch.text(
      next === 'sign-in' ? 'New here? Create an account' : 'Already have an account? Sign in',
    );
    $password.attr('autocomplete', next === 'sign-in' ? 'current-password' : 'new-password');
  };

  $switch.on('click', (event) => {
    event.preventDefault();
    setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
  });

  $form.on('submit', async (event) => {
    event.preventDefault();

    const email = String($email.val() ?? '').trim();
    const password = String($password.val() ?? '');
    $error.addClass('hide');
    $notice.addClass('hide');

    if (!email || !email.includes('@')) {
      showError('Enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      showError('Password must be at least 6 characters.');
      return;
    }

    const $buttonEl = $submit;
    const busyLabel = mode === 'sign-in' ? 'Signing in…' : 'Creating account…';
    $buttonEl.prop('disabled', true).text(busyLabel);

    try {
      const result =
        mode === 'sign-in'
          ? await sync.signIn(email, password)
          : await sync.signUp(email, password);

      if (!result.ok) {
        showError(result.message ?? 'Something went wrong. Try again.');
        return;
      }

      $password.val('');
      showToast('Signed in — your notes will sync to the cloud.');
      // The status subscription swaps the panes; keep the modal open so the
      // user sees the account view with the fresh sync state.
    } finally {
      $buttonEl.prop('disabled', false);
      // Deliberately NOT calling setMode here: it would wipe the error
      // message the failure path above just rendered.
    }
  });

  $('#cloudSyncNow').on('click', () => {
    sync.syncNow();
  });

  $('#cloudSignOut').on('click', async () => {
    await sync.signOut();
    showToast('Signed out. Your notes stay on this device.');
    setMode('sign-in');
  });

  // Settings → Cloud sync → Manage: leave Settings, open the Cloud modal.
  $('#cloudSettingsManage').on('click', () => {
    closeModal($('#preferencesModal').get(0));
    setTimeout(() => {
      openModal($('#cloudModal').get(0));
    }, 200);
  });

  function showError(message: string): void {
    $notice.addClass('hide');
    $error.text(message).removeClass('hide');
  }

  function renderModal(status: CloudStatus): void {
    const signedIn = status.state === 'signed-in';
    const $paneIn = $('#cloudSignedInPane');
    $('#cloudModalStatusDot').attr('class', `cloud-status-dot ${dotFor(status)}`);
    $pane.attr('hidden', signedIn ? 'hidden' : null);
    $paneIn.attr('hidden', signedIn ? null : 'hidden');

    if (signedIn) {
      $('#cloudAccountEmail').text(status.email);
      // The avatar carries the account's initial — a face for the account
      // row that a bare email never had.
      $('#cloudAccountAvatar').text((status.email.trim()[0] ?? '·').toUpperCase());
      $('#cloudLastSync').text(
        status.lastSyncAt
          ? `Last sync ${formatTime(status.lastSyncAt)}`
          : 'Syncing for the first time…',
      );
      $('#cloudStatusLine').text(statusLine(status));
    }

    // The manual sync button spins while a sync is in flight — the click
    // is otherwise indistinguishable from a miss.
    $('#cloudSyncNow').toggleClass(
      'is-busy',
      signedIn && (status.sync === 'syncing' || status.sync === 'pending'),
    );
  }

  function renderSettingsSummary(status: CloudStatus): void {
    const $summary = $('#cloudSettingsSummary');
    const signedIn = status.state === 'signed-in';
    $summary.text(
      signedIn
        ? `${statusLine(status)} — ${status.email}`
        : 'Sign in to back up your notes and pick them up on any device.',
    );
  }

  function dotFor(status: CloudStatus): string {
    switch (status.state) {
      case 'signed-in':
        return status.sync === 'idle'
          ? DotState.OK
          : status.sync === 'offline'
            ? DotState.ERROR
            : DotState.BUSY;
      case 'error':
        return DotState.ERROR;
      default:
        return DotState.OFF;
    }
  }

  function statusLine(status: CloudStatus): string {
    switch (status.state) {
      case 'signed-in':
        switch (status.sync) {
          case 'syncing':
            return 'Syncing…';
          case 'pending':
            return 'Changes waiting to upload';
          case 'offline':
            return 'Offline — will retry automatically';
          default:
            // "Everything is backed up" stops being true the moment one
            // note cannot leave the device: the warning replaces the
            // reassurance, because the reassurance is now a lie.
            return status.warning ?? 'Everything is backed up';
        }
      case 'error':
        return status.message;
      default:
        return '';
    }
  }

  setMode('sign-in');

  // Subscribe last: the listener fires immediately with the current status,
  // so every const above must already be initialized.
  sync.subscribe(renderStatus);
}

function openCloudModal(): void {
  openModal($('#cloudModal').get(0));
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}
