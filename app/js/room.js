/**
 * Created by benjaminsmiley-andrews on 09/10/2014.
 */

var myApp = angular.module('myApp.room', ['firebase']);

myApp.factory('Room', ['$rootScope','$timeout','$q', '$window','Config','Message','Cache','User', 'Presence', 'LocalStorage', 'Rooms', 'RoomPositionManager', 'SoundEffects', 'Visibility', 'Log',
    function ($rootScope, $timeout, $q, $window, Config, Message, Cache, User, Presence, LocalStorage, Rooms, RoomPositionManager, SoundEffects, Visibility, Log) {
        return {

            getOrCreateRoomWithID: function (rid) {

                var room = Rooms.getRoomWithID(rid);

                if(!room) {
                    room = this.buildRoomWithID(rid);
                    Cache.addRoom(room);
                }
                room.height = bChatRoomHeight;
                room.width = bChatRoomWidth;

                return room;
            },

            buildRoomWithID: function (rid) {

                var room = this.newRoom();
                room.meta.rid = rid;

                // Update the room from the saved state
                LocalStorage.updateRoomFromCookies(room);

                return room;
            },

            newRoom: function (name, invitesEnabled, description, userCreated, isPublic, weight) {

                var room = {

                    meta: {
                        name: name,
                        invitesEnabled: invitesEnabled,
                        description: description,
                        userCreated: !unORNull(userCreated) ? userCreated : true,
                        isPublic: !unORNull(isPublic) ? isPublic : false,
                        created: Firebase.ServerValue.TIMESTAMP
                    },
                    users: {},
                    usersMeta: {},
                    userCount: 0,
                    messages: [],
                    typing: {},
                    typingMessage: null,
                    badge: 0,

                    // Layout
                    offset: 0, // The x offset
                    dragDirection: 0, // drag direction +ve / -ve

                    width: bChatRoomWidth,
                    height: bChatRoomHeight,
                    zIndex: null,
                    active: true, // in side list or not
                    minimized: false,
                    loadingMoreMessages: false,
                    loadingTimer: null,
                    muted: false

                };

                /***********************************
                 * GETTERS AND SETTERS
                 */

                room.setRID = function (rid) {
                    room.meta.rid = rid;
                };

                room.getRID = function () {
                    return room.meta.rid;
                };

                room.getUserCreated = function () {
                    return room.meta.userCreated;
                };

                /***********************************
                 * UPDATE METHOD
                 */

                room.update = function () {
                    room.updateName();
                    room.updateOnlineUserCount();
                    $rootScope.$broadcast(bRoomUpdatedNotification, room);
                };

                room.updateTyping = function () {

                    var i = 0;
                    var name = null;
                    for(var key in room.typing) {
                        if(room.typing.hasOwnProperty(key)) {
                            if(key == $rootScope.user.meta.uid) {
                                continue;
                            }
                            name = room.typing[key];
                            i++;
                        }
                    }

                    var typing = null;
                    if (i == 1) {
                        typing = name + "...";
                    }
                    else if (i > 1) {
                        typing = i + " people typing";
                    }

                    room.typingMessage = typing;
                };

                room.updateOnlineUserCount = function () {
                    room.userCount = room.onlineUserCount();
                };

                room.updateName = function () {

                    if(room.meta && room.meta.name) {
                        room.name = room.meta.name;
                        return;
                    }

                    // How many users are there?
                    var i = 0;
                    for(var key in room.users) {
                        if(room.users.hasOwnProperty(key)) {
                            i++;
                        }
                    }
                    // TODO: Do this better
                    if(i == 2) {
                        for(key in room.users) {
                            if(room.users.hasOwnProperty(key)) {
                                var user = room.users[key];

                                // We only want to use the name of a user
                                // who isn't the current user
                                if(Cache.onlineUsers[user.meta.uid]) {
                                    if(user.meta.name) {
                                        room.name = user.meta.name;
                                    }
                                }
                            }
                        }
                    }

                    // Private chat x users
                    // Ben Smiley
                    if(!room.name) {
                        room.name = bGroupChatDefaultName;
                    }

                };

                /***********************************
                 * LIFECYCLE
                 */

                room.create = function (users) {

                    var deferred = $q.defer();

                    // Check to see if there's already a room between us and the
                    // other user
                    if(users && users.length == 1) {
                        var r = Rooms.getRoomWithOtherUser(users[0]);
                        var user = users[0];
                        if(r && user) {

                            return $q.all([
                                r.addUser(user, bUserStatusInvited),
                                user.addRoom(r)
                            ]);
                        }
                    }

                    var ref = Paths.roomsRef();

                    // Create a new child ref
                    var roomRef = null;
                    if(room.meta.rid) {
                        roomRef = ref.child(room.meta.rid);
                    }
                    else {
                        roomRef = ref.push();
                        room.meta.rid = roomRef.key();
                    }

                    var roomMetaRef = Paths.roomMetaRef(roomRef.key());

                    // Does the room already exist?
                    roomMetaRef.once('value', function (snapshot) {

                        if(snapshot && snapshot.val()) {
                            // If this is a public room then add it to the list of
                            // public rooms
                            if(room.meta.isPublic) {
                                return room.addToPublicRooms();
                            }
                        }
                        else {

                            // Add the room to Firebase
                            roomMetaRef.set(room.meta, (function (error) {

                                if(error) {
                                    deferred.reject(error);
                                }
                                else {

                                    // Add the users
                                    this.join(bUserStatusOwner);

                                    for (var i in users) {
                                        if(users.hasOwnProperty(i)) {
                                            room.addUser(users[i], bUserStatusInvited);
                                            users[i].addRoom(room);
                                        }
                                    }

                                    // If this is a public room then add it to the list of
                                    // public rooms
                                    if(room.meta.isPublic) {
                                        room.addToPublicRooms();
                                    }

                                    // Update the state
                                    room.updateState(bMetaKey);

                                    deferred.resolve();
                                }

                            }).bind(room));
                        }
                    });

                    return deferred.promise;

                };

                room.remove = function () {
                    // TODO: Don't listen to hundres of rooms
                    room.messagesOff();

                    room.leave();

                    // Remove the room from the cache
                    RoomPositionManager.removeRoom(room);

                };

                room.delete = function () {

                    var deferred = $q.defer();

                    var ref = Paths.roomRef(room.getRID());
                    ref.remove(function (error) {
                        if(!error) {
                            deferred.resolve()
                        }
                        else {
                            deferred.reject(error);
                        }
                    });

                    return deferred.promise;

                };

                room.join = function (status) {
                    if(room) {
                        // Add the user to the room
                        room.addUser($rootScope.user, status);

                        // Add the room to the user
                        $rootScope.user.addRoom(room);
                    }
                };

                room.leave = function () {
                    if(room) {
                        // Remove the user from the room
                        //room.removeUser($rootScope.user);
                        room.setStatusForUser($rootScope.user, bUserStatusClosed);

                        // Remove the room from the user's list
                        $rootScope.user.removeRoom(room);
                    }
                };

                room.canInviteUser = function () {

                    // Is this room an invite only room?
                    if(room.meta.invitesEnabled) {
                        return true;
                    }
                    else {
                        // Are we the owner?
                        var owner = room.getOwner();
                        if(owner && owner.meta) {
                            return owner.meta.uid == $rootScope.user.meta.uid;
                        }
                        else {
                            return false;
                        }
                    }
                };

                room.setActive = function (active) {
                    if(active) {
                        room.markRead();
                    }
                    room.active = active;
                };

                /***********************************
                 * USERS
                 */

                room.getUserInfo = function (user) {
                    // This could be called from the UI so it's important
                    // to wait until users has been populated
                    if(room.usersMeta && user && user.meta) {
                        return room.usersMeta[user.meta.uid];
                    }
                    return null;
                };

                room.getUserStatus = function (user) {
                    var info = room.getUserInfo(user);
                    return info ? info.status : null;
                };

                room.getUsers = function () {
                    var users = {};
                    for(var key in room.users) {
                        if(room.users.hasOwnProperty(key)) {
                            var user = room.users[key];
                            if(user.meta && $rootScope.user && $rootScope.user.meta) {
                                if(user.meta.uid != $rootScope.user.meta.uid && room.getUserStatus(user) != bUserStatusClosed) {
                                    users[user.meta.uid] = user;
                                }
                            }
                        }
                    }
                    return users;
                };

                room.getOwner = function () {
                    // get the owner's ID
                    var data = null;

                    for(var key in room.usersMeta) {
                        if(room.usersMeta.hasOwnProperty(key)) {
                            data = room.usersMeta[key];
                            if(data.status == bUserStatusOwner) {
                                break;
                            }
                        }
                    }
                    if(data) {
                        return Cache.getOrCreateUserWithID(data.uid);
                    }
                    return null;
                };

                room.containsUser = function (user) {
                    if(room.users[user.meta.uid]) {
                        return true;
                    }
                    return false;
                };

                room.addUser = function (user, status) {

                    var deferred = $q.defer();

                    // Are we able to invite the user?
                    // If the user is us or if the room is public then we can
                    if(user == $rootScope.user) {//} || Cache.getPublicRoomWithID(room.meta.rid)) {

                    }
                    else if(!room.canInviteUser() && status != bUserStatusOwner) {
                        $rootScope.showNotification(bNotificationTypeAlert, 'Invites disabled', 'The creator of this room has disabled invites', 'ok');
                        return;
                    }

                    // If the user is already a member of the
                    // room
                    var currentStatus = room.getUserStatus(user);
                    if(currentStatus && currentStatus != bUserStatusClosed) {
                        deferred.resolve();
                        return deferred.promise;
                    }
                    else {
                        this.setStatusForUser(user, status);
                    }
                };

                room.setStatusForUser = function(user, status) {

                    var deferred = $q.defer();

                    var ref = Paths.roomUsersRef(room.meta.rid);
                    ref.child(user.meta.uid).update({
                        status: status,
                        uid: user.meta.uid
                    }, function (error) {
                        if(!error) {
                            deferred.resolve();
                        }
                        else {
                            deferred.reject(error);
                        }
                    });

                    return deferred.promise;
                };

                /***********************************
                 * ROOM INFORMATION
                 */

                room.onlineUserCount = function () {
                    var user;
                    var i = 0;
                    for(var key in room.usersMeta) {
                        if(room.users.hasOwnProperty(key)) {
                            user = room.usersMeta[key];
                            if($rootScope.user && $rootScope.user.meta) {
                                if((Cache.onlineUsers[user.uid] || $rootScope.user.meta.uid == user.uid) && user.status != bUserStatusClosed) {
                                    i++;
                                }
                            }
                        }
                    }
                    return i;
                };

                /**
                 * This function will return the time in seconds
                 * since a message was posted in the room - if
                 *
                 */
                room.timeSinceLastMessage = function () {

                    if(unORNull(room.meta.lastUpdated)) {

                        return 60 * 60 * 24 * 10;
                    }
                    else {
                        var date =  new Date(room.meta.lastUpdated);
                        var time = 0;
                        if(!date.now) {
                            time = date.getTime();
                        }
                        else {
                            time = date.now();
                        }
                        return time * 1000;
                    }

                },

                /**
                 * Checks the rooms meta data to see if it
                 * is inactive
                 * Rooms are considered inactive if:
                 * - They've been created more than 3 days ago
                 * - They have no users and no messages have been added in the last day
                 * - They have users but no messages have been added in the last 2 days
                 */
                room.isInactive = function () {

                    // If this is a static room then
                    // we just return
                    if(!room.meta.userCreated) {
                        return false;
                    }

                    var created = timeSince(room.meta.created);

                    // This is a room that was created before this patch
                    // went live - therefore we'll delete it
                    if(created < 0) {
                        return true;
                    }
                    else {

                        // If the room was created more than three days
                        // ago it's a candidate to be deleted
                        if(created > bDay * 3) {

                            var lastUpdated = timeSince(room.meta.lastUpdated);

                            // if there are no users check when
                            if(room.onlineUserCount() == 0) {

                                // Check when the last message was sent
                                if(lastUpdated < 0 || lastUpdated > bDay) {
                                    return true;
                                }
                            }
                            else {
                                // Check when the last message was sent
                                if(lastUpdated < 0 || lastUpdated > bDay * 2) {
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                };

                /***********************************
                 * LAYOUT
                 */

//                room.slot = function () {
//                    return Layout.nearestSlotToOffset(room.offset);
//                };

                // If the room is animating then
                // return the destination
                room.getOffset = function () {
                    if(room.roomState == room.room_state_animating) {
                        return room.destinationOffset;
                    }
                    else {
                        return room.offset;
                    }
                };

                room.getCenterX = function () {
                    return room.getOffset() + room.width / 2;
                };

                room.getMinX = function () {
                    return room.getOffset();
                };

                room.getMaxX = function () {
                    return room.getOffset() + room.width;
                };

                room.updateOffsetFromSlot = function () {
                    room.setOffset(RoomPositionManager.offsetForSlot(room.slot));
                };

                room.setOffset = function(offset) {
                    room.offset = offset;
                };

                room.setSlot = function (slot) {
                    room.slot = slot;
                };

                /***********************************
                 * MESSAGES
                 */

                room.sendMessage = function (text, user) {

                    if(!text || text.length === 0)
                        return;

                    // Make the message
                    var message = Message.newMessage(room.meta.rid, user.meta.uid, text);
                    message.user = null;

                    // Get a ref to the room
                    var ref = Paths.roomMessagesRef(room.meta.rid);

                    // Add the message
                    var newRef = ref.push();
                    newRef.setWithPriority(message.meta, Firebase.ServerValue.TIMESTAMP);

                    // Now update this room with this data
                    var roomMetaRef = Paths.roomMetaRef(room.meta.rid);

                    //
                    var lastMessageMeta = message.meta;
                    lastMessageMeta['userName'] = user.meta.name;

                    // Update the room
                    roomMetaRef.update({
                        lastUpdated: Firebase.ServerValue.TIMESTAMP,
                        lastMessage: lastMessageMeta
                    });

                    room.updateState(bMessagesPath);

                    // Update the user's presence state
                    Presence.update();

                };

                room.loadMoreMessages = function (callback, numberOfMessages) {

                    if(!numberOfMessages) {
                        numberOfMessages = 10;
                    }

                    if(room.loadingMoreMessages) {
                        return;
                    }

                    // If we already have a message then only listen for new
                    // messages
                    if(room.messages.length && room.lastMessage.meta.time) {

                        room.loadingMoreMessages = true;

                        // Also get the messages from the room
                        var ref = Paths.roomMessagesRef(room.meta.rid).orderByPriority();

                        ref = ref.endAt(room.messages[0].meta.time);
                        ref = ref.limitToLast(numberOfMessages);

                        // Store the messages locally
                        var messages = [];

                        var finishQuery = (function () {

                            $timeout.cancel(this.loadingTimer);

                            // Stop listening to reference
                            ref.off();

                            // Add messages to front of global list
                            // Ignore the last message - it's a duplicate
                            var lastMessage = null;
                            for(var i = messages.length - 2; i >= 0; i--) {
                                if(this.messages.length > 0) {
                                    lastMessage = this.messages[0];
                                }
                                this.messages.unshift(messages[i]);
                                if(lastMessage) {
                                    lastMessage.hideName = lastMessage.shouldHideUser(messages[i]);
                                    lastMessage.hideTime = lastMessage.shouldHideDate(messages[i]);
                                }
                            }

                            room.loadingMoreMessages = false;

                            $rootScope.$broadcast(bLazyLoadedMessagesNotification, room, callback);



                        }).bind(this);

                        // Set a timeout for the query - if it's not finished
                        // after 1 second finish it manually
                        this.loadingTimer = $timeout(function () {
                            finishQuery();
                        }, 1000);

                        ref.on('child_added', (function (snapshot) {
                            var val = snapshot.val();
                            if(val) {
                                var message = Message.buildMessage(snapshot.key(), val);
                                messages.push(message);
                                if(messages.length == numberOfMessages) {
                                    finishQuery();
                                }
                            }
                        }).bind(this));
                    }
                };

                room.sortMessages = function () {
                    // Now we should sort all messages
                    this.sortMessageArray(this.messages);
                };

                room.sortMessageArray = function (messages) {
                    messages.sort(function (a, b) {
                        return a.meta.time - b.meta.time;
                    });
                };

                room.markRead = function () {

                    var messages = room.unreadMessages;

                    if(messages && messages.length > 0) {

                        for(var i in messages) {
                            if(messages.hasOwnProperty(i)) {
                                messages[i].markRead();
                            }
                        }

                        // Clear the messages array
                        while(messages.length > 0) {
                            messages.pop();
                        }
                    }
                    room.badge = null;
                };

                room.transcript = function () {

                    var transcript = "";

                    // Loop over messages and format them
                    var messages = room.getMessages();

                    var m = null;
                    for(var i in messages) {
                        if(messages.hasOwnProperty(i)) {
                            m = messages[i];
                            transcript += moment(m.meta.time).format('HH:mm:ss') + " " + m.user.meta.name + ": " + m.meta.text + "\n";
                        }
                    }

                    return transcript;
                };

                /***********************************
                 * TYPING INDICATOR
                 */

                room.startTyping = function (user) {
                    // The user is typing...
                    var ref = Paths.roomTypingRef(room.meta.rid).child(user.meta.uid);
                    ref.set({name: user.meta.name});

                    // If the user disconnects, tidy up by removing the typing
                    // indicator
                    ref.onDisconnect().remove();
                };

                room.finishTyping = function (user) {
                    var ref = Paths.roomTypingRef(room.meta.rid).child(user.meta.uid);
                    ref.remove();
                };

                /***********************************
                 * SERIALIZATION
                 */

                room.serialize = function () {
                    var m = [];
                    for(var i = 0; i < room.messages; i++) {
                        m.push(room.messages[i].serialize());
                    }
                    var sr = {
                        minimized: room.minimized,
                        width: room.width,
                        height: room.height,
                        //offset: room.offset,
                        messages: m,
                        meta: room.meta,
                        usersMeta: room.usersMeta
                    };

                    if(DEBUG) console.log("Serialize: Offet: " + room.offset);

                    return sr;
                };

                room.deserialize = function (sr) {

                    room.minimized = sr.minimized;
                    room.width = sr.width;
                    room.height = sr.height;
                    room.meta = sr.meta;
                    room.usersMeta = sr.usersMeta;
                    //room.offset = sr.offset;

                    for(var i = 0; i < sr.messages.length; i++) {
                        var message = Message.buildRoomWithID(room.meta.rid);
                        message.deserialize(sr.messages[i]);
                        room.messages.push(message);
                    }

                    if(DEBUG) console.log("Deserialize: Offet: " + room.offset);
                };

                /***********************************
                 * FIREBASE
                 */

                /**
                 * Start listening to updates in the
                 * room meta data
                 */
                room.on = function () {

                    var deferred = $q.defer();

                    if(room.isOn || !room.meta || !room.meta.rid) {
                        deferred.resolve();
                        return deferred.promise;
                    }
                    room.isOn = true;

                    room.userOnlineStateChangedNotificationOff = $rootScope.$on(bUserOnlineStateChangedNotification, function (event, user) {
                        Log.notification(bUserOnlineStateChangedNotification, 'Room');

                        // If the user is a member of this room, update the room
                        room.update();
                    });

                    // Get the room meta data
                    var ref = Paths.roomMetaRef(room.meta.rid);

                    ref.on('value', (function(snapshot) {
                        room.meta = snapshot.val();

                        // Update the room's meta data
                        room.update();


                        deferred.resolve();

                    }).bind(this));

                    // Listen to users being added to the thread
                    ref = Paths.roomUsersRef(room.meta.rid);
                    ref.on('child_added', function (snapshot) {
                        // Get the user
                        if(snapshot.val()) {

                            var uid = snapshot.val().uid;

                            var user = Cache.getOrCreateUserWithID(uid);

                            room.users[user.meta.uid] = user;

                            // Update the room's meta data
                            room.update();

                        }
                    });

                    ref.on('child_removed', function (snapshot) {
                        if(snapshot.val()) {

                            var uid = snapshot.val().uid;

                            delete room.users[uid];

                            // Update the room's meta data
                            room.update();

                        }
                    });

                    ref.on('value', function (snapshot) {
                        if(snapshot && snapshot.val()) {
                            room.usersMeta = snapshot.val();

                            // Update the room's meta data
                            room.update();
                        }
                    });

                    // Handle typing
                    ref = Paths.roomTypingRef(room.meta.rid);

                    ref.on('child_added', function (snapshot) {
                        room.typing[snapshot.key()] = snapshot.val().name;

                        room.updateTyping();

                        // Send a notification to the chat room
                        $rootScope.$broadcast(bChatUpdatedNotification, room);
                    });

                    ref.on('child_removed', function (snapshot) {
                        delete room.typing[snapshot.key()];

                        room.updateTyping();

                        // Send a notification to the chat room
                        $rootScope.$broadcast(bChatUpdatedNotification, room);
                    });

                    return deferred.promise;
                };

                /**
                 * Start listening to messages being added
                 */
                room.messagesOn = function () {

                    // Make sure the room is valid
                    if(room.messagesAreOn || !room.meta || !room.meta.rid) {
                        return;
                    }
                    room.messagesAreOn = true;

                    // Also get the messages from the room
                    var ref = Paths.roomMessagesRef(room.meta.rid);

                    // If we already have a message then only listen for new
                    // messages
                    if(room.lastMessage && room.lastMessage.meta.time) {
                        ref = ref.startAt(room.lastMessage.meta.time);
                    }
                    else {
                        ref = ref.limitToLast(Config.maxHistoricMessages);
                    }

                    // Add listen to messages added to this thread
                    ref.on('child_added', function (snapshot) {

                        // Get the snapshot value
                        var val = snapshot.val();

                        if(!val || !val.text || val.text.length === 0) {
                            return;
                        }

                        if(room.lastMessage) {
                            // Sometimes we get double messages
                            // check that this message hasn't been added already
                            if(room.lastMessage.mid == snapshot.key()) {
                                return;
                            }
                        }

                        // Create the message object
                        var message = Message.buildMessage(snapshot.key(), val);

                        // Is the window visible?
                        // Play the sound
                        if(!room.muted) {
                            if(Visibility.getIsHidden()) {
                                SoundEffects.messageReceived();
                            }
                        }

                        // Change the page title
                        $window.document.title = message.meta.text + "...";

                        // Add the message to this room
                        if(message) {

                            // This logic handles whether the date and name should be
                            // show

                            // Get the previous message if it exists
                            if(room.lastMessage) {

                                var lastMessage = room.lastMessage;

                                // We hide the name on the last message if it is sent by the
                                // same message as this message i.e.
                                // - User 1 (name hidden)
                                // - User 1
                                lastMessage.hideName = lastMessage.shouldHideUser(message);
                                //lastMessage.hideName = message.meta.uid == lastMessage.meta.uid;

                                // Last message date
                                //var lastDate = new Date(lastMessage.meta.time);
                                //var newDate = new Date(message.meta.time);

                                // If messages have the same day, hour and minute
                                // hide the time

                                //lastMessage.hideTime = lastDate.getDay() == newDate.getDay() && lastDate.getHours() == newDate.getHours() && lastDate.getMinutes() == newDate.getMinutes();

                                lastMessage.hideTime = lastMessage.shouldHideDate(message);

                                // Add a pointer to the lastMessage
                                message.lastMessage = lastMessage;

                            }

                            // We always hide the time for the latest message
                            message.hideTime = true;

                            room.messages.push(message);

                            room.sortMessages();

                            room.lastMessage = message;
                            room.messagesDirty = true;
                        }

                        // If the room is inactive or minimized increase the badge
                        if((!room.active || room.minimized) && !message.readBy()) {

                            if(!room.unreadMessages) {
                                room.unreadMessages  = [];
                            }

                            room.unreadMessages.push(message);

                            // If this is the first badge then room.badge will
                            // undefined - so set it to one
                            if(!room.badge) {
                                room.badge = 1;
                            }
                            else {
                                room.badge = Math.min(room.badge + 1, 99);
                            }
                        }
                        else {
                            // Is the room active? If it is then mark the message
                            // as seen
                            message.markRead();
                        }

                        room.update();

                    });
                };

                room.messagesOff = function () {

                    room.messagesAreOn = false;

                    // Get the room meta data
                    if(room.meta && room.meta.rid) {
                        Paths.roomMessagesRef(room.meta.rid).off();
                    }
                };

                room.off = function () {

                    room.isOn = false;

                    if(room.userOnlineStateChangedNotificationOff) {
                        room.userOnlineStateChangedNotificationOff();
                    }

                    room.messagesOff();

                    // Get the room meta data
                    Paths.roomMetaRef(room.meta.rid).off();
                    Paths.roomUsersRef(room.meta.rid).off();
                    Paths.roomTypingRef(room.meta.rid).off();
                };

                /**
                 * If this public room doesn't already exist
                 * add it to the list of public rooms
                 * @returns {promise}
                 */
                room.addToPublicRooms = function () {

                    var deferred = $q.defer();

                    // Does this room already exist?
                    var ref = Paths.publicRoomRef(room.getRID());
                    ref.once('value', function(snapshot) {
                        if(!snapshot.val()) {
                            ref.set({
                                rid: room.meta.rid,
                                created: Firebase.ServerValue.TIMESTAMP,
                                userCreated: room.getUserCreated()
                            }, function (error) {
                                if(!error) {
                                    deferred.resolve();
                                }
                                else {
                                    deferred.reject(error);
                                }
                            });
                        }
                    });

                    return deferred.promise;
                }

                /**
                 * Remove a public room
                 * @returns {promise}
                 */
                room.removeFromPublicRooms = function () {

                    var deferred = $q.defer();

                    var ref = Paths.publicRoomRef(room.getRID());
                    ref.remove(function (error) {
                        if(!error) {
                            deferred.resolve();
                        }
                        else {
                            deferred.reject(error);
                        }
                    });

                    return deferred.promise;
                };

                /***********************************
                 * ROOM STATE
                 */

                room.updateState = function (key) {

                    var deferred = $q.defer();

                    var ref = Paths.roomStateRef(room.meta.rid);

                    var data = {}; data[key] = Firebase.ServerValue.TIMESTAMP;

                    ref.update(data, function (error) {
                        if(!error) {
                            deferred.resolve();
                        }
                        else {
                            deferred.reject(error);
                        }
                    });
                    return deferred.promise;
                };

                return room;
            }
        };
    }]);