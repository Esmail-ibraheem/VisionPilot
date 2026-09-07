# VisionPilot
The Operating System of OpenVision (Physical AI Computer). 


**1. OpenVision — software + hardware**
The software is the machine’s **AI operating system/runtime**. It uses cameras and vision models such as ViTs/VLMs to understand the surrounding world, then plans actions according to the machine type.

The hardware is the physical interface: cameras, Raspberry Pi / Jetson / custom compute board, IMU, GPS, CAN/GPIO interfaces, and eventually a dedicated OpenMotion device.

So conceptually:

```text

OpenMotion
Cameras/Sensors → AI OS → Understand → Plan → Control Machine
       HARDWARE       SOFTWARE              HARDWARE
```

And VisionPilot changes behavior based on the machine:

```text
Drone       → fly / avoid / land
Wheelchair  → navigate / stop / turn
Forklift    → drive / lift / avoid workers
Robot       → move / grasp / interact
Boat        → navigate / steer / avoid obstacles
```

