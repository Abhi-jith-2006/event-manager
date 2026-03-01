require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const path = require("path");
const bcrypt = require("bcrypt");

const app = express();

/* ------------------ MIDDLEWARE ------------------ */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: "hackathon-secret",
  resave: false,
  saveUninitialized: false
}));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

/* ------------------ DB CONNECTION ------------------ */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/* ------------------ AUTH ------------------ */

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const { roll, password } = req.body;

    if (!roll || !password) {
      return res.render("login", { error: "All fields required" });
    }

    const student = await pool.query(
      "SELECT * FROM students WHERE roll_number=$1",
      [roll]
    );

    if (student.rows.length === 0) {
      return res.render("login", { error: "User not found" });
    }

    const valid = await bcrypt.compare(
      password,
      student.rows[0].password
    );

    if (!valid) {
      return res.render("login", { error: "Incorrect password" });
    }

    req.session.student = student.rows[0];
    res.redirect("/calendar");

  } catch (err) {
    console.error(err);
    res.render("login", { error: "Login failed" });
  }
});

/* ------------------ REGISTER ACCOUNT ------------------ */

app.get("/register", (req, res) => {
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  try {
    const { name, roll, password } = req.body;

    if (!name || !roll || !password) {
      return res.render("register", { error: "All fields required" });
    }

    const existing = await pool.query(
      "SELECT * FROM students WHERE roll_number=$1",
      [roll]
    );

    if (existing.rows.length > 0) {
      return res.render("register", { error: "User already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO students(name, roll_number, password) VALUES($1,$2,$3)",
      [name, roll, hashed]
    );

    res.redirect("/login");

  } catch (err) {
    console.error(err);
    res.render("register", { error: "Registration failed" });
  }
});

/* ------------------ CALENDAR HOME ------------------ */

app.get("/calendar", async (req, res) => {
  if (!req.session.student) return res.redirect("/login");

  const events = await pool.query("SELECT * FROM events");

  const registered = await pool.query(
    `SELECT e.id, e.title, e.event_date
     FROM registrations r
     JOIN events e ON r.event_id = e.id
     WHERE r.student_id = $1
     ORDER BY e.event_date`,
    [req.session.student.id]
  );

  res.render("calendar", {
    student: req.session.student,
    events: events.rows,
    registeredEvents: registered.rows
  });
});

/* ------------------ EVENT DETAILS ------------------ */

app.get("/event/:id", async (req, res) => {
  if (!req.session.student) return res.redirect("/login");

  const event = await pool.query(
    "SELECT * FROM events WHERE id=$1",
    [req.params.id]
  );

  if (event.rows.length === 0) {
    return res.status(404).send("Event not found");
  }

  const count = await pool.query(
    "SELECT COUNT(*) FROM registrations WHERE event_id=$1",
    [req.params.id]
  );

  const alreadyRegistered = await pool.query(
    "SELECT * FROM registrations WHERE student_id=$1 AND event_id=$2",
    [req.session.student.id, req.params.id]
  );

  res.render("event", {
    student: req.session.student,
    event: event.rows[0],
    registeredCount: parseInt(count.rows[0].count),
    alreadyRegistered: alreadyRegistered.rows.length > 0
  });
});

/* ------------------ REGISTER FOR EVENT ------------------ */

app.post("/register/:id", async (req, res) => {
  if (!req.session.student) return res.redirect("/login");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const event = await client.query(
      "SELECT seats_filled, max_seats FROM events WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );

    if (event.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Event not found");
    }

    if (event.rows[0].seats_filled >= event.rows[0].max_seats) {
      await client.query("ROLLBACK");
      return res.redirect("/event/" + req.params.id);
    }

    await client.query(
      "INSERT INTO registrations(student_id, event_id) VALUES($1,$2)",
      [req.session.student.id, req.params.id]
    );

    await client.query(
      "UPDATE events SET seats_filled = seats_filled + 1 WHERE id=$1",
      [req.params.id]
    );

    await client.query("COMMIT");
    res.redirect("/event/" + req.params.id);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.redirect("/event/" + req.params.id);
  } finally {
    client.release();
  }
});

/* ------------------ CANCEL REGISTRATION ------------------ */

app.post("/cancel/:id", async (req, res) => {
  if (!req.session.student) return res.redirect("/login");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check registration exists
    const registration = await client.query(
      "SELECT * FROM registrations WHERE student_id=$1 AND event_id=$2",
      [req.session.student.id, req.params.id]
    );

    if (registration.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.redirect("/calendar");
    }

    // Lock event row
    await client.query(
      "SELECT * FROM events WHERE id=$1 FOR UPDATE",
      [req.params.id]
    );

    // Delete registration
    await client.query(
      "DELETE FROM registrations WHERE student_id=$1 AND event_id=$2",
      [req.session.student.id, req.params.id]
    );

    // Decrement seat safely
    await client.query(
      "UPDATE events SET seats_filled = seats_filled - 1 WHERE id=$1 AND seats_filled > 0",
      [req.params.id]
    );

    await client.query("COMMIT");
    res.redirect("/calendar");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.redirect("/calendar");
  } finally {
    client.release();
  }
});

/* ------------------ LOGOUT ------------------ */

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* ------------------ START SERVER ------------------ */

app.listen(3000, () => console.log("Running on 3000"));