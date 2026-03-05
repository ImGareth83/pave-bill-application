# Pave Bank Assignment

## PAVE Coding Challenge

### Purpose
The purpose of this coding challenge is:

- To see what kind of coder you are
- So you can see what kind of technology you’ll be working on
- So we can work together to solve a tricky problem and see if our communication skills are compatible

When you’ve completed your solution, send us your GitHub and we’ll schedule a call to discuss it.

### Challenge
Build a fees API in [Encore](https://encore.dev) that uses a [Temporal](https://temporal.io) workflow started at the beginning of a fee period, and allows progressive accrual of fees.

At the end of the billing period, the total invoice and bill summation should be available.

### Requirements
- Able to create a new bill
- Able to add a line item to an existing open bill
- Able to close an active bill:
  - Indicate total amount being charged
  - Indicate all line items being charged
- Reject line item addition if bill is closed (bill already charged)
- Able to query open and closed bills
- Able to handle different types of currency (for simplicity, assume GEL and USD)

You are free to design the RESTful API that will be used by other services. The above requirements are not exhaustive; you are free to add requirements that you think are helpful in making the Fees API more flexible and complete.

### Things to Consider
- How should money be represented?
- What are the correct semantics for the API?
- Data modeling and lifecycle of entity
- What problems does Temporal solve?

### AI Usage
We encourage you to use AI. In particular, we suggest asking GPT-5 or Claude for a "critical code review" of your solution before you return it to us.

This models how we work in the real world: we want to test your architectural skills, not nitpick small details that AI can help you with.

### Hint
[https://encore.dev/docs/how-to/temporal](https://encore.dev/docs/how-to/temporal)
