// @flow

import { readyToClose } from '../../../features/mobile/external-api/actions';
import {
    ACTION_PINNED,
    ACTION_UNPINNED,
    createOfferAnswerFailedEvent,
    createPinnedEvent
} from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { reloadNow } from '../../app/actions';
import { removeLobbyChatParticipant } from '../../chat/actions.any';
import { openDisplayNamePrompt } from '../../display-name/actions';
import { showErrorNotification, showWarningNotification } from '../../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../../notifications/constants';
import { setIAmVisitor } from '../../visitors/actions';
import { overwriteConfig } from '../config/actions';
import { CONNECTION_ESTABLISHED, CONNECTION_FAILED } from '../connection/actionTypes';
import { connect, connectionDisconnected, disconnect } from '../connection/actions';
import { validateJwt } from '../jwt/functions';
import { JitsiConferenceErrors } from '../lib-jitsi-meet';
import { PARTICIPANT_UPDATED, PIN_PARTICIPANT } from '../participants/actionTypes';
import { PARTICIPANT_ROLE } from '../participants/constants';
import {
    getLocalParticipant,
    getParticipantById,
    getPinnedParticipant
} from '../participants/functions';
import MiddlewareRegistry from '../redux/MiddlewareRegistry';
import { TRACK_ADDED, TRACK_REMOVED } from '../tracks/actionTypes';
import { destroyLocalTracks } from '../tracks/actions.any';

import {
    CONFERENCE_FAILED,
    CONFERENCE_JOINED,
    CONFERENCE_SUBJECT_CHANGED,
    CONFERENCE_WILL_LEAVE,
    SEND_TONES,
    SET_PENDING_SUBJECT_CHANGE,
    SET_ROOM
} from './actionTypes';
import {
    conferenceFailed,
    conferenceWillLeave,
    createConference,
    leaveConference,
    setLocalSubject,
    setSubject
} from './actions';
import {
    CONFERENCE_DESTROYED_LEAVE_TIMEOUT,
    CONFERENCE_LEAVE_REASONS,
    TRIGGER_READY_TO_CLOSE_REASONS
} from './constants';
import {
    _addLocalTracksToConference,
    _removeLocalTracksFromConference,
    forEachConference,
    getCurrentConference,
    getVisitorOptions,
    restoreConferenceOptions
} from './functions';
import logger from './logger';

declare var APP: Object;

/**
 * Handler for before unload event.
 */
let beforeUnloadHandler;

/**
 * Implements the middleware of the feature base/conference.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case CONFERENCE_FAILED:
        return _conferenceFailed(store, next, action);

    case CONFERENCE_JOINED:
        return _conferenceJoined(store, next, action);

    case CONNECTION_ESTABLISHED:
        return _connectionEstablished(store, next, action);

    case CONNECTION_FAILED:
        return _connectionFailed(store, next, action);

    case CONFERENCE_SUBJECT_CHANGED:
        return _conferenceSubjectChanged(store, next, action);

    case CONFERENCE_WILL_LEAVE:
        _conferenceWillLeave(store);
        break;

    case PARTICIPANT_UPDATED:
        return _updateLocalParticipantInConference(store, next, action);

    case PIN_PARTICIPANT:
        return _pinParticipant(store, next, action);

    case SEND_TONES:
        return _sendTones(store, next, action);

    case SET_ROOM:
        return _setRoom(store, next, action);

    case TRACK_ADDED:
    case TRACK_REMOVED:
        return _trackAddedOrRemoved(store, next, action);
    }

    return next(action);
});

/**
 * Makes sure to leave a failed conference in order to release any allocated
 * resources like peer connections, emit participant left events, etc.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code CONFERENCE_FAILED} which is
 * being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _conferenceFailed({ dispatch, getState }, next, action) {
    const { conference, error } = action;

    if (error.name === JitsiConferenceErrors.REDIRECTED) {
        if (typeof error.recoverable === 'undefined') {
            error.recoverable = true;
        }
    }

    const result = next(action);
    const { enableForcedReload } = getState()['features/base/config'];

    // Handle specific failure reasons.
    switch (error.name) {
    case JitsiConferenceErrors.CONFERENCE_DESTROYED: {
        const [ reason ] = error.params;

        dispatch(showWarningNotification({
            description: reason,
            titleKey: 'dialog.sessTerminated'
        }, NOTIFICATION_TIMEOUT_TYPE.LONG));

        if (TRIGGER_READY_TO_CLOSE_REASONS.includes(reason)) {
            if (typeof APP === 'undefined') {
                dispatch(readyToClose());
            } else {
                APP.API.notifyReadyToClose();
            }
            setTimeout(() => dispatch(leaveConference()), CONFERENCE_DESTROYED_LEAVE_TIMEOUT);
        }

        break;
    }
    case JitsiConferenceErrors.CONFERENCE_RESTARTED: {
        if (enableForcedReload) {
            dispatch(showErrorNotification({
                description: 'Restart initiated because of a bridge failure',
                titleKey: 'dialog.sessionRestarted'
            }, NOTIFICATION_TIMEOUT_TYPE.LONG));
        }

        break;
    }
    case JitsiConferenceErrors.CONNECTION_ERROR: {
        const [ msg ] = error.params;

        dispatch(connectionDisconnected(getState()['features/base/connection'].connection));
        dispatch(showErrorNotification({
            descriptionArguments: { msg },
            descriptionKey: msg ? 'dialog.connectErrorWithMsg' : 'dialog.connectError',
            titleKey: 'connection.CONNFAIL'
        }, NOTIFICATION_TIMEOUT_TYPE.LONG));

        break;
    }
    case JitsiConferenceErrors.CONFERENCE_MAX_USERS: {
        if (typeof APP === 'undefined') {
            // in case of max users(it can be from a visitor node), let's restore
            // oldConfig if any as we will be back to the main prosody
            const newConfig = restoreConferenceOptions(getState);

            if (newConfig) {
                dispatch(overwriteConfig(newConfig))
                    .then(dispatch(conferenceWillLeave(conference)))
                    .then(conference.leave())
                    .then(dispatch(disconnect()))
                    .then(dispatch(connect()));
            }
        }

        break;
    }
    case JitsiConferenceErrors.OFFER_ANSWER_FAILED:
        sendAnalytics(createOfferAnswerFailedEvent());
        break;
    case JitsiConferenceErrors.REDIRECTED: {
        // once conference.js is gone this can be removed and both
        // redirect logics to be merged
        if (typeof APP === 'undefined') {
            const newConfig = getVisitorOptions(getState, error.params);

            if (!newConfig) {
                logger.warn('Not redirected missing params');
                break;
            }

            const [ vnode ] = error.params;

            dispatch(overwriteConfig(newConfig))
                .then(dispatch(conferenceWillLeave(conference)))
                .then(conference.leave())
                .then(dispatch(disconnect()))
                .then(dispatch(setIAmVisitor(Boolean(vnode))))

                // we do not clear local tracks on error, so we need to manually clear them
                .then(dispatch(destroyLocalTracks()))
                .then(dispatch(connect()));
        }
        break;
    }
    }

    if (typeof APP === 'undefined') {
        !error.recoverable
        && conference
        && conference.leave(CONFERENCE_LEAVE_REASONS.UNRECOVERABLE_ERROR).catch(reason => {
            // Even though we don't care too much about the failure, it may be
            // good to know that it happen, so log it (on the info level).
            logger.info('JitsiConference.leave() rejected with:', reason);
        });
    } else {
        // FIXME: Workaround for the web version. Currently, the creation of the
        // conference is handled by /conference.js and appropriate failure handlers
        // are set there.
        _removeUnloadHandler(getState);
    }

    if (enableForcedReload && error?.name === JitsiConferenceErrors.CONFERENCE_RESTARTED) {
        dispatch(conferenceWillLeave(conference));
        dispatch(reloadNow());
    }

    return result;
}

/**
 * Does extra sync up on properties that may need to be updated after the
 * conference was joined.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code CONFERENCE_JOINED} which is
 * being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _conferenceJoined({ dispatch, getState }, next, action) {
    const result = next(action);
    const { conference } = action;
    const { pendingSubjectChange } = getState()['features/base/conference'];
    const {
        disableBeforeUnloadHandlers = false,
        requireDisplayName
    } = getState()['features/base/config'];

    dispatch(removeLobbyChatParticipant(true));

    pendingSubjectChange && dispatch(setSubject(pendingSubjectChange));

    // FIXME: Very dirty solution. This will work on web only.
    // When the user closes the window or quits the browser, lib-jitsi-meet
    // handles the process of leaving the conference. This is temporary solution
    // that should cover the described use case as part of the effort to
    // implement the conferenceWillLeave action for web.
    beforeUnloadHandler = () => {
        dispatch(conferenceWillLeave(conference));
    };
    window.addEventListener(disableBeforeUnloadHandlers ? 'unload' : 'beforeunload', beforeUnloadHandler);

    if (requireDisplayName
        && !getLocalParticipant(getState)?.name
        && !conference.isHidden()) {
        dispatch(openDisplayNamePrompt(undefined));
    }

    return result;
}

/**
 * Notifies the feature base/conference that the action
 * {@code CONNECTION_ESTABLISHED} is being dispatched within a specific redux
 * store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code CONNECTION_ESTABLISHED}
 * which is being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _connectionEstablished({ dispatch }, next, action) {
    const result = next(action);

    // FIXME: Workaround for the web version. Currently, the creation of the
    // conference is handled by /conference.js.
    typeof APP === 'undefined' && dispatch(createConference());

    return result;
}

/**
 * Logs jwt validation errors from xmpp and from the client-side validator.
 *
 * @param {string} message -The error message from xmpp.
 * @param {Object} state - The redux state.
 * @returns {void}
 */
function _logJwtErrors(message, state) {
    const { jwt } = state['features/base/jwt'];

    if (!jwt) {
        return;
    }

    const errorKeys = validateJwt(jwt);

    message && logger.error(`JWT error: ${message}`);
    errorKeys.length && logger.error('JWT parsing error:', errorKeys);
}

/**
 * Notifies the feature base/conference that the action
 * {@code CONNECTION_FAILED} is being dispatched within a specific redux
 * store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code CONNECTION_FAILED} which is
 * being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _connectionFailed({ dispatch, getState }, next, action) {
    _logJwtErrors(action.error.message, getState());

    const result = next(action);

    _removeUnloadHandler(getState);

    // FIXME: Workaround for the web version. Currently, the creation of the
    // conference is handled by /conference.js and appropriate failure handlers
    // are set there.
    if (typeof APP === 'undefined') {
        const { connection } = action;
        const { error } = action;

        forEachConference(getState, conference => {
            // It feels that it would make things easier if JitsiConference
            // in lib-jitsi-meet would monitor it's connection and emit
            // CONFERENCE_FAILED when it's dropped. It has more knowledge on
            // whether it can recover or not. But because the reload screen
            // and the retry logic is implemented in the app maybe it can be
            // left this way for now.
            if (conference.getConnection() === connection) {
                // XXX Note that on mobile the error type passed to
                // connectionFailed is always an object with .name property.
                // This fact needs to be checked prior to enabling this logic on
                // web.
                const conferenceAction
                    = conferenceFailed(conference, error.name);

                // Copy the recoverable flag if set on the CONNECTION_FAILED
                // action to not emit recoverable action caused by
                // a non-recoverable one.
                if (typeof error.recoverable !== 'undefined') {
                    conferenceAction.error.recoverable = error.recoverable;
                }

                dispatch(conferenceAction);
            }

            return true;
        });
    }

    return result;
}

/**
 * Notifies the feature base/conference that the action
 * {@code CONFERENCE_SUBJECT_CHANGED} is being dispatched within a specific
 *  redux store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code CONFERENCE_SUBJECT_CHANGED}
 * which is being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _conferenceSubjectChanged({ dispatch, getState }, next, action) {
    const result = next(action);
    const { subject } = getState()['features/base/conference'];

    if (subject) {
        dispatch({
            type: SET_PENDING_SUBJECT_CHANGE,
            subject: undefined
        });
    }

    typeof APP === 'object' && APP.API.notifySubjectChanged(subject);

    return result;
}

/**
 * Notifies the feature base/conference that the action
 * {@code CONFERENCE_WILL_LEAVE} is being dispatched within a specific redux
 * store.
 *
 * @private
 * @param {Object} store - The redux store.
 * @returns {void}
 */
function _conferenceWillLeave({ getState }: { getState: Function }) {
    _removeUnloadHandler(getState);
}

/**
 * Notifies the feature base/conference that the action {@code PIN_PARTICIPANT}
 * is being dispatched within a specific redux store. Pins the specified remote
 * participant in the associated conference, ignores the local participant.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code PIN_PARTICIPANT} which is
 * being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _pinParticipant({ getState }, next, action) {
    const state = getState();
    const { conference } = state['features/base/conference'];

    if (!conference) {
        return next(action);
    }

    const id = action.participant.id;
    const participantById = getParticipantById(state, id);
    const pinnedParticipant = getPinnedParticipant(state);
    const actionName = id ? ACTION_PINNED : ACTION_UNPINNED;
    const local
        = (participantById && participantById.local)
            || (!id && pinnedParticipant && pinnedParticipant.local);
    let participantIdForEvent;

    if (local) {
        participantIdForEvent = local;
    } else {
        participantIdForEvent
            = actionName === ACTION_PINNED ? id : pinnedParticipant && pinnedParticipant.id;
    }

    sendAnalytics(createPinnedEvent(
        actionName,
        participantIdForEvent,
        {
            local,
            'participant_count': conference.getParticipantCount()
        }));

    return next(action);
}

/**
 * Removes the unload handler.
 *
 * @param {Function} getState - The redux getState function.
 * @returns {void}
 */
function _removeUnloadHandler(getState) {
    if (typeof beforeUnloadHandler !== 'undefined') {
        const { disableBeforeUnloadHandlers = false } = getState()['features/base/config'];

        window.removeEventListener(disableBeforeUnloadHandlers ? 'unload' : 'beforeunload', beforeUnloadHandler);
        beforeUnloadHandler = undefined;
    }
}

/**
 * Requests the specified tones to be played.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code SEND_TONES} which is
 * being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _sendTones({ getState }, next, action) {
    const state = getState();
    const { conference } = state['features/base/conference'];

    if (conference) {
        const { duration, tones, pause } = action;

        conference.sendTones(tones, duration, pause);
    }

    return next(action);
}

/**
 * Notifies the feature base/conference that the action
 * {@code SET_ROOM} is being dispatched within a specific
 *  redux store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code SET_ROOM}
 * which is being dispatched in the specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _setRoom({ dispatch, getState }, next, action) {
    const state = getState();
    const { localSubject, subject } = state['features/base/config'];
    const { room } = action;

    if (room) {
        // Set the stored subject.
        dispatch(setLocalSubject(localSubject));
        dispatch(setSubject(subject));
    }

    return next(action);
}

/**
 * Synchronizes local tracks from state with local tracks in JitsiConference
 * instance.
 *
 * @param {Store} store - The redux store.
 * @param {Object} action - Action object.
 * @private
 * @returns {Promise}
 */
function _syncConferenceLocalTracksWithState({ getState }, action) {
    const conference = getCurrentConference(getState);
    let promise;

    if (conference) {
        const track = action.track.jitsiTrack;

        if (action.type === TRACK_ADDED) {
            promise = _addLocalTracksToConference(conference, [ track ]);
        } else {
            promise = _removeLocalTracksFromConference(conference, [ track ]);
        }
    }

    return promise || Promise.resolve();
}

/**
 * Notifies the feature base/conference that the action {@code TRACK_ADDED}
 * or {@code TRACK_REMOVED} is being dispatched within a specific redux store.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action {@code TRACK_ADDED} or
 * {@code TRACK_REMOVED} which is being dispatched in the specified
 * {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _trackAddedOrRemoved(store, next, action) {
    const track = action.track;

    // TODO All track swapping should happen here instead of conference.js.
    if (track?.local) {
        return (
            _syncConferenceLocalTracksWithState(store, action)
                .then(() => next(action)));
    }

    return next(action);
}

/**
 * Updates the conference object when the local participant is updated.
 *
 * @param {Store} store - The redux store in which the specified {@code action}
 * is being dispatched.
 * @param {Dispatch} next - The redux {@code dispatch} function to dispatch the
 * specified {@code action} to the specified {@code store}.
 * @param {Action} action - The redux action which is being dispatched in the
 * specified {@code store}.
 * @private
 * @returns {Object} The value returned by {@code next(action)}.
 */
function _updateLocalParticipantInConference({ dispatch, getState }, next, action) {
    const { conference } = getState()['features/base/conference'];
    const { participant } = action;
    const result = next(action);

    const localParticipant = getLocalParticipant(getState);

    if (conference && participant.id === localParticipant?.id) {
        if ('name' in participant) {
            conference.setDisplayName(participant.name);
        }

        if ('role' in participant && participant.role === PARTICIPANT_ROLE.MODERATOR) {
            const { pendingSubjectChange, subject } = getState()['features/base/conference'];

            // When the local user role is updated to moderator and we have a pending subject change
            // which was not reflected we need to set it (the first time we tried was before becoming moderator).
            if (typeof pendingSubjectChange !== 'undefined' && pendingSubjectChange !== subject) {
                dispatch(setSubject(pendingSubjectChange));
            }
        }
    }

    return result;
}
