require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const path = require("path");

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

/* ------------------ LOGIN ------------------ */

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  try {
    const { name, roll } = req.body;

    if (!name || !roll) {
      return res.send("All fields required");
    }

    let student = await pool.query(
      "SELECT * FROM students WHERE roll_number=$1",
      [roll]
    );

    if (student.rows.length === 0) {
      student = await pool.query(
        "INSERT INTO students(name, roll_number) VALUES($1,$2) RETURNING *",
        [name, roll]
      );
    }

    req.session.student = student.rows[0];
    res.redirect("/calendar");

  } catch (err) {
    console.error(err);
    res.send("Login error");
  }
});

/* ------------------ CALENDAR HOME ------------------ */

app.get("/calendar", async (req, res) => {
  if (!req.session.student) return res.redirect("/login");

  const events = await pool.query("SELECT * FROM events");

  res.render("calendar", {
    student: req.session.student,
    events: events.rows
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

  res.render("event", {
    student: req.session.student,
    event: event.rows[0],
    registeredCount: parseInt(count.rows[0].count)
  });
});

/* ------------------ REGISTER FOR EVENT ------------------ */

app.post("/register/:id", async (req, res) => {
  if (!req.session.student) {
    return res.redirect("/login");
  }

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

/* ------------------ LOGOUT ------------------ */

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* ------------------ START SERVER ------------------ */

app.listen(3000, () => console.log("Running on 3000"));