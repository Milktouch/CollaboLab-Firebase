/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const logger = require("firebase-functions/logger");
const { auth } = require("firebase-admin");
const {getFirestore } = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");
const admin = require("firebase-admin");
const serviceAccount = require("./collabolab-e1e9f-firebase-adminsdk-9qk29-11457d9310.json");
const functions = require("firebase-functions");
const regionFunctions = functions.region("europe-west1");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const firestore = getFirestore();
const fcm = getMessaging();
const nullUserId = "W2fwORpFcBjiTBICwnwm";

async function sendSystemMessage(projectId, message) {
  const projRef = firestore.collection("projects").doc(projectId);
  await projRef.collection("chat").add({
    text: message,
    from: "System",
    userId: "",
    timestamp: new Date(),
  });
}


async function getFcmtoken(userId) {
  const userDoc = await firestore.collection("users").doc(userId).get();
  return userDoc.data().fcmToken;
}

async function putUserUpdate(userId, data) {
  await firestore.collection("users").doc(userId).collection("otherUpdates").add(data);
}

async function sendUserUpdate(userId, data) {
  const fcmToken = await getFcmtoken(userId);
  if (fcmToken != "" && fcmToken != undefined) {
    fcm.send({
      notification: {
        title: data.title,
        body: data.description,
      },
      token: fcmToken
    });
  }
  await putUserUpdate(userId, data);
}

async function sendReloadDocumentMessage(path) {
  const message = {
    data: {
      path: path,
      action: "reload",
    },
    topic: "all",
  };
  fcm.send(message);
}


exports.createUser = regionFunctions.https.onCall(async (data, context) => {
  const db = getFirestore();
  const name = data.name;
  const email = data.email;
  const password = data.password;
  const phone = data.phone;
  const userExists = await auth()
    .getUserByEmail(email)
    .then(() => true)
    .catch((error) => false);
  if (userExists) {
    logger.error("User already exists");
    return { error: "User already exists" };
  }
  logger.info("Creating user with email: ", email);
  return await auth()
    .createUser({
      email: email,
      emailVerified: false,
      password: password,
      displayName: name,
      disabled: false,
    })
    .then((userRecord) => {
      // See the UserRecord reference doc for the contents of userRecord.
      logger.info("Successfully created new user:", userRecord.uid);
      db.collection("users")
        .doc(userRecord.uid)
        .set({
          "name": name,
          "email": email,
          "projects": [],
          "phone": phone?phone:"",
          "password": password,
        })
        .then(() => {
          logger.info("User data added to firestore");
        });
        return { uid: userRecord.uid };
    })
    .catch((error) => {
      logger.error("Error creating new user:", error);
      return { error: error };
    });
});
exports.sendChatMessage = regionFunctions.https.onCall(
  async (data, context) => {
    const text = data.text;
    const from = data.from;
    const projectId = data.projectId;
    const userId = context.auth.uid;
    if (userId == "") {
      logger.error("Invalid session token");
      return { error: "User must be logged in" };
    }
    const db = getFirestore();
    const projRef = db.collection("projects").doc(projectId);
    const projData = await projRef.get();
    return projRef
      .collection("chat")
      .add({
        text: text,
        from: from,
        userId: userId,
        timestamp: new Date(),
      })
      .then(() => {
        logger.info("Message sent by ", from, " in ", projectId);
        const msg = {
          notification: {
            title: `New message in ${projData.data().name}`,
            body: `${from} sent a new message`,
          },
          topic: projectId,
        };
        fcm.send(msg);
        return { message: "Message sent", error: "" };
      })
      .catch((error) => {
        logger.error("Error sending message:", error);
        return { error: error };
      });
  }
);
exports.createProject = regionFunctions.https.onCall(async (data, context) => {
  const name = data.name;
  const description = data.description;
  const fcmToken = data.fcmToken;
  const userId = context.auth.uid;
  if (userId == "") {
    logger.error("Invalid session token");
    return { error: "Invalid auth token" };
  }
  const db = getFirestore();
  const projRef = db.collection("projects");
  const userDoc = await db.collection("users").doc(userId).get();
  return await projRef
    .add({
      name: name,
      description: description,
      members: [],
      ownerId: userId,
    })
    .then((docRef) => {
      logger.info("Project created with ID: ", docRef.id);
      const projArr = userDoc.data().projects;
      projArr.push(docRef.id);
      db.collection("users")
        .doc(userId)
        .update({
          projects: projArr,
        })
        .then(() => {
          logger.info("Project added to user");
        });
      fcm.subscribeToTopic(fcmToken, docRef.id);
      db.collection("projects")
        .doc(docRef.id)
        .collection("permissions")
        .doc(userId)
        .set({
          "create task": true,
          "edit task": true,
          "delete task": true,
          "review task": true,
          "manage permissions": true,
          "kick member": true,
          invite: true,
        });
      return { projectId: docRef.id };
    })
    .catch((error) => {
      logger.error("Error creating project:", error);
      return { error: error };
    });
});
exports.deleteProject = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const userId = context.auth.uid;
  const db = getFirestore();
  const projDoc = await db.collection("projects").doc(projectId).get();
  if (projDoc.data().ownerId != userId) {
    logger.error("User not authorized to delete project");
    return { error: "User not authorized to delete project" };
  }
  projDoc.data().members.forEach(async (member) => {
    const userDoc = db.collection("users").doc(member);
    const projArr = userDoc.data().projects;
    projArr.splice(projArr.indexOf(projectId), 1);
    userDoc.ref.update({
      projects: projArr,
    });
  });
  const userDoc = db.collection("users").doc(userId);
  const projArr = userDoc.data().projects;
  projArr.splice(projArr.indexOf(projectId), 1);
  userDoc.ref.update({
    projects: projArr,
  });
  db.collection("projects").doc(projectId).delete();
  return { message: "Project deleted" };
});
exports.searchUser = regionFunctions.https.onCall(async (data, context) => {
  const text = data.text;
  const projectId = data.projectId;
  const db = getFirestore();
  const users = [];
  await db
    .collection("users")
    .get()
    .then((querySnapshot) => {
      querySnapshot.forEach((doc) => {
        const projArr = doc.data().projects;
        if (!projArr.includes(projectId)) {
          if (
            doc.data().name.toLowerCase().includes(text) ||
            doc.data().email.toLowerCase().includes(text)
          ) {
            users.push({
              id: doc.id,
              name: doc.data().name,
              email: doc.data().email,
            });
          }
        }
      });
    });
  return { users: users };
});
exports.inviteUser = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const userId = data.userId;
  const db = getFirestore();
  const projDoc = await db.collection("projects").doc(projectId).get();
  await db
    .collection("users")
    .doc(userId)
    .collection("invites")
    .doc(projectId)
    .set({
      name: projDoc.data().name,
      description: projDoc.data().description,
      projectId: projectId,
    });
  sendUserUpdate(userId, {
    viewType: "one time",
    title: "Project invite",
    description: `You have been invited to join ${projDoc.data().name}`,
  });
  return { message: "User invited" };
});
exports.acceptInvite = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const userId = context.auth.uid;
  const db = getFirestore();
  const projDoc = await db.collection("projects").doc(projectId).get();
  const memArr = projDoc.data().members;
  memArr.push(userId);
  projDoc.ref.update({
    members: memArr,
  });
  const userDoc = await db.collection("users").doc(userId).get();
  const projArr = userDoc.data().projects;
  projArr.push(projectId);
  userDoc.ref.update({
    projects: projArr,
  });
  const fcmToken = userDoc.data().fcmToken;
  if (fcmToken != "" && fcmToken != undefined) {
    fcm.subscribeToTopic(fcmToken, projectId);
  }
  db.collection("users")
    .doc(userId)
    .collection("invites")
    .doc(projectId)
    .delete();
  sendSystemMessage(projectId, `${userDoc.data().name} has joined the project`);
  return { message: "Invite accepted" };
});
exports.removeFromProject = regionFunctions.https.onCall(
  async (data, context) => {
    const projectId = data.projectId;
    const userId = data.userId;
    const db = getFirestore();
    const projDoc = await db.collection("projects").doc(projectId).get();
    const memArr = projDoc.data().members;
    memArr.splice(memArr.indexOf(userId), 1);
    projDoc.ref.update({
      members: memArr,
    });
    const userDoc = await db.collection("users").doc(userId).get();
    const projArr = userDoc.data().projects;
    projArr.splice(projArr.indexOf(projectId), 1);
    userDoc.ref.update({
      projects: projArr,
    });
    const fcmToken = userDoc.data().fcmToken;
    if (fcmToken != "" && fcmToken != undefined) {
      fcm.unsubscribeFromTopic(fcmToken, projectId);
    }
    await db
      .collection("projects")
      .doc(projectId)
      .collection("permissions")
      .doc(userId)
      .delete();
    await db
      .collection("projects")
      .doc(projectId)
      .collection("tasks")
      .where("assignedTo", "==", userId)
      .get()
      .then((querySnapshot) => {
        querySnapshot.forEach((doc) => {
          doc.ref.update({
            assignedTo: nullUserId,
          });
        });
      });
    if (data.userDecision) {
      sendSystemMessage(
        projectId,
        `${userDoc.data().name} has left the project`
      );
    } else {
      sendSystemMessage(
        projectId,
        `${userDoc.data().name} has been removed from the project`
      );
      sendUserUpdate(userId, {
        viewType: "one time",
        title: "Removed from project",
        description: `You have been removed from ${projDoc.data().name}`,
      });
    }
    return { message: "User removed from project" };
  }
);
exports.sendTaskToReview = regionFunctions.https.onCall(
  async (data, context) => {
    const projectId = data.projectId;
    const db = getFirestore();
    const projDoc = await db.collection("projects").doc(projectId).get();
    const reviewers = await db
      .collection("projects")
      .doc(projectId)
      .collection("permissions")
      .where("review task", "==", true)
      .get();
    reviewers.forEach(async (doc) => {
      const id = doc.id;
      await sendUserUpdate(id, {
        viewType: "one time",
        title: "Task for review",
        description: `A task has been sent for review in ${
          projDoc.data().name
        }`,
      });
    });
    return { message: "Task sent for review" };
  }
);
exports.approveTask = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const taskId = data.taskId;
  const db = getFirestore();
  logger.log(new Date());
  logger.log("Approving task with id: ", taskId, " in project: ", projectId);
  const taskDoc = await db
    .collection("projects")
    .doc(projectId)
    .collection("tasks")
    .doc(taskId)
    .get();
  if (taskDoc.data().assignedTo != nullUserId) {
    await sendUserUpdate(taskDoc.data().assignedTo, {
      viewType: "one time",
      title: "Task approved",
      description: `Your task has been approved`,
    });
    const userDoc = await db
      .collection("users")
      .doc(taskDoc.data().assignedTo)
      .get();
    sendSystemMessage(
      projectId,
      `${userDoc.data().name} has completed "${taskDoc.data().name}" task`
    );
  }

  return { message: "Task approved" };
});
exports.updateTask = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const taskId = data.taskId;
  const db = getFirestore();
  const taskDoc = await db
    .collection("projects")
    .doc(projectId)
    .collection("tasks")
    .doc(taskId)
    .get();
  sendUserUpdate(taskDoc.data().assignedTo, {
    viewType: "one time",
    title: "Task updated",
    description: `task "${taskDoc.data().name}" information has been updated`,
  });
  return { message: "Task updated" };
});
exports.assignTask = regionFunctions.https.onCall(async (data, context) => {
  const projectId = data.projectId;
  const userId = data.userId;
  const db = getFirestore();
  const projDoc = await db.collection("projects").doc(projectId).get();
  sendUserUpdate(userId, {
    viewType: "one time",
    title: "New Task",
    description: `a task has been assigned to you in ${projDoc.data().name}`,
  });
  return { message: "Task assigned" };
});
exports.notifyUser = regionFunctions.https.onCall(async (data,context)=>{
  const userId = data.userId;
  await sendUserUpdate(userId,{
    viewType: "one time",
    title: data.title,
    description: data.description
  });
  return {message:"Notification sent"};
});
exports.getUserTasks = regionFunctions.https.onCall(async (data,context)=>{
  const userId = context.auth.uid;
  const db = getFirestore();
  const tasks = [];
  const userDoc = await db.collection("users").doc(userId).get();
  const projArr = userDoc.data().projects;
  const promises = [];
  projArr.forEach(async (projId)=>{
    const promise = db.collection("projects").doc(projId).collection("tasks").where("assignedTo","==",userId).get().then((querySnapshot)=>{
      querySnapshot.forEach((doc)=>{
        if(doc.data().status != "Complete")
          tasks.push(doc.ref.path)
      });
    });
    promises.push(promise);
  });
  await Promise.all(promises);
  return {"tasks":tasks};
});
exports.deleteUser = regionFunctions.https.onCall(async (data,context)=>{
  const userId = data.userId;
  const db = getFirestore();
  const userDoc = await db.collection("users").doc(userId).get();
  const projArr = userDoc.data().projects;
  projArr.forEach(async (projId)=>{
    const projDoc = await db.collection("projects").doc(projId).get();
    const memArr = projDoc.data().members;
    if(projDoc.data().ownerId != userId){
      memArr.splice(memArr.indexOf(userId),1);
      projDoc.ref.update({
        members: memArr,
     });
     await db
       .collection("projects")
       .doc(projId)
       .collection("permissions")
       .doc(userId)
       .delete();
     await db
       .collection("projects")
       .doc(projId)
       .collection("tasks")
       .where("assignedTo", "==", userId)
       .get()
       .then((querySnapshot) => {
         querySnapshot.forEach((doc) => {
           doc.ref.update({
             assignedTo: nullUserId,
           });
         });
       });
    }
    else{
      projDoc.ref.delete();
      memArr.forEach(async (member)=>{
        const memDoc = await db.collection("users").doc(member).get()
        const memProjArr = memDoc.data().projects;
        memProjArr.splice(memProjArr.indexOf(projId),1);
        memDoc.ref.update({
          projects: memProjArr
        });
    });
  }
  });
  await auth().deleteUser(userId);
  await db.collection("users").doc(userId).delete();
  return {message:"User deleted"};
});